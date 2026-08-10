import type { PrismaClient } from "@prisma/client";
import { writePlanningAudit } from "./audit.js";

export type ParsedDeliveryConstraints = {
  requiredTimeWindow: { start: string; end: string } | null;
  preferredTimeWindow: { start: string; end: string } | null;
  unavailableWindows: Array<{ weekday: number; start: string; end: string }>;
  callBeforeMinutes: number | null;
  serviceDurationMinutes: number | null;
  allowEarlyDelivery: boolean | null;
  allowLateDelivery: boolean | null;
  timeWindowPriority: "required" | "preferred" | null;
  confidence: number;
  requiresReview: boolean;
  rawModelMeta: { modelVersion: string; promptVersion: string };
};

const PROMPT_VERSION = "constraints-v1";

/** 無 OpenAI 時的簡易規則解析（不猜測座標；僅常見時段句型） */
function heuristicParse(noteText: string): ParsedDeliveryConstraints {
  const text = noteText.replace(/\s+/g, "");
  let required: { start: string; end: string } | null = null;
  let preferred: { start: string; end: string } | null = null;
  let priority: "required" | "preferred" | null = null;
  let confidence = 0.4;
  let requiresReview = true;

  const beforeMatch = text.match(/(?:上午|早上)?(\d{1,2})點前/);
  if (beforeMatch) {
    const h = Math.min(23, Math.max(0, Number(beforeMatch[1])));
    required = { start: "08:00", end: `${String(h).padStart(2, "0")}:00` };
    priority = "required";
    confidence = 0.7;
    requiresReview = false;
  } else if (/上午|早上/.test(text) && !/下午/.test(text)) {
    preferred = { start: "08:00", end: "12:00" };
    priority = "preferred";
    confidence = 0.55;
  } else if (/下午/.test(text) && !/上午|早上/.test(text)) {
    preferred = { start: "13:00", end: "18:00" };
    priority = "preferred";
    confidence = 0.55;
  }

  let callBeforeMinutes: number | null = null;
  if (/電話|打電話|來電/.test(text)) {
    callBeforeMinutes = 30;
    confidence = Math.min(0.95, confidence + 0.1);
  }

  return {
    requiredTimeWindow: required,
    preferredTimeWindow: preferred,
    unavailableWindows: [],
    callBeforeMinutes,
    serviceDurationMinutes: null,
    allowEarlyDelivery: null,
    allowLateDelivery: null,
    timeWindowPriority: priority,
    confidence,
    requiresReview,
    rawModelMeta: { modelVersion: "heuristic", promptVersion: PROMPT_VERSION },
  };
}

async function openaiParse(noteText: string): Promise<ParsedDeliveryConstraints | null> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const model = (process.env.OPENAI_MODEL ?? "gpt-4.1-mini").trim();
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      required_time_window: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              start: { type: "string" },
              end: { type: "string" },
            },
            required: ["start", "end"],
          },
          { type: "null" },
        ],
      },
      preferred_time_window: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              start: { type: "string" },
              end: { type: "string" },
            },
            required: ["start", "end"],
          },
          { type: "null" },
        ],
      },
      unavailable_windows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            weekday: { type: "integer" },
            start: { type: "string" },
            end: { type: "string" },
          },
          required: ["weekday", "start", "end"],
        },
      },
      call_before_minutes: { anyOf: [{ type: "integer" }, { type: "null" }] },
      service_duration_minutes: { anyOf: [{ type: "integer" }, { type: "null" }] },
      allow_early_delivery: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      allow_late_delivery: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      time_window_priority: {
        anyOf: [{ type: "string", enum: ["required", "preferred"] }, { type: "null" }],
      },
      confidence: { type: "number" },
      requires_review: { type: "boolean" },
    },
    required: [
      "required_time_window",
      "preferred_time_window",
      "unavailable_windows",
      "call_before_minutes",
      "service_duration_minutes",
      "allow_early_delivery",
      "allow_late_delivery",
      "time_window_priority",
      "confidence",
      "requires_review",
    ],
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "你是物流調度助理。從中文配送備註抽出時間窗與限制，輸出符合 schema 的 JSON。時間用 HH:mm（24h）。weekday: 1=週一 … 7=週日。不要捏造地址或司機。",
        },
        { role: "user", content: noteText },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "delivery_constraints",
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[parse-constraints] openai error", res.status, errText);
    return null;
  }

  const data = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  let raw = data.output_text ?? "";
  if (!raw && Array.isArray(data.output)) {
    for (const item of data.output) {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) {
          raw = c.text;
          break;
        }
      }
    }
  }
  if (!raw) return null;

  const parsed = JSON.parse(raw) as {
    required_time_window: { start: string; end: string } | null;
    preferred_time_window: { start: string; end: string } | null;
    unavailable_windows: Array<{ weekday: number; start: string; end: string }>;
    call_before_minutes: number | null;
    service_duration_minutes: number | null;
    allow_early_delivery: boolean | null;
    allow_late_delivery: boolean | null;
    time_window_priority: "required" | "preferred" | null;
    confidence: number;
    requires_review: boolean;
  };

  return {
    requiredTimeWindow: parsed.required_time_window,
    preferredTimeWindow: parsed.preferred_time_window,
    unavailableWindows: parsed.unavailable_windows ?? [],
    callBeforeMinutes: parsed.call_before_minutes,
    serviceDurationMinutes: parsed.service_duration_minutes,
    allowEarlyDelivery: parsed.allow_early_delivery,
    allowLateDelivery: parsed.allow_late_delivery,
    timeWindowPriority: parsed.time_window_priority,
    confidence: Number(parsed.confidence) || 0,
    requiresReview: Boolean(parsed.requires_review),
    rawModelMeta: { modelVersion: model, promptVersion: PROMPT_VERSION },
  };
}

function hhmmToDate(hhmm: string | null | undefined): Date | null {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(Date.UTC(1970, 0, 1, h!, m!, 0));
  return d;
}

export async function parseDeliveryConstraints(
  prisma: PrismaClient,
  args: {
    noteText: string;
    salesOrderId?: bigint | null;
    persist?: boolean;
    actorUserId?: bigint | null;
  },
): Promise<ParsedDeliveryConstraints> {
  const noteText = args.noteText.trim();
  if (!noteText) {
    throw new Error("noteText 必填");
  }

  let result = await openaiParse(noteText);
  if (!result) result = heuristicParse(noteText);

  if (args.persist && args.salesOrderId) {
    const tw = result.requiredTimeWindow ?? result.preferredTimeWindow;
    await prisma.salesOrder.update({
      where: { id: args.salesOrderId },
      data: {
        deliveryWindowStart: tw ? hhmmToDate(tw.start) : undefined,
        deliveryWindowEnd: tw ? hhmmToDate(tw.end) : undefined,
        preferredTimeNote: noteText.slice(0, 200),
        serviceDurationMinutes: result.serviceDurationMinutes ?? undefined,
        allowEarlyDelivery: result.allowEarlyDelivery ?? undefined,
        allowLateDelivery: result.allowLateDelivery ?? undefined,
        timeWindowPriority: result.timeWindowPriority ?? undefined,
      },
    });
  }

  await writePlanningAudit(prisma, {
    action: "parse_constraints",
    modelVersion: result.rawModelMeta.modelVersion,
    promptVersion: result.rawModelMeta.promptVersion,
    actorUserId: args.actorUserId ?? null,
    inputSummary: {
      salesOrderId: args.salesOrderId?.toString() ?? null,
      noteLength: noteText.length,
      persist: Boolean(args.persist),
    },
    outputSummary: {
      timeWindowPriority: result.timeWindowPriority,
      confidence: result.confidence,
      requiresReview: result.requiresReview,
    },
  });

  return result;
}
