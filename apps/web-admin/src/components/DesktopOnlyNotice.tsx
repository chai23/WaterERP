import { useMediaQuery } from "../useMediaQuery";

type Props = {
  feature: string;
};

export function DesktopOnlyNotice({ feature }: Props) {
  const isMobile = useMediaQuery("(max-width: 768px)");
  if (!isMobile) return null;

  return (
    <div className="alert desktop-only-notice" role="status">
      <strong>{feature}</strong>建議使用電腦或平板橫向操作；手機上部分編輯與預覽功能可能不便使用。
    </div>
  );
}
