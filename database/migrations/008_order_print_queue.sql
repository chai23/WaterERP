CREATE TABLE IF NOT EXISTS order_print_stations (
  station_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  last_seen DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_print_jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  station_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  order_no VARCHAR(64) NOT NULL,
  payload MEDIUMTEXT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3) NULL,
  INDEX idx_order_print_station (station_hash, status, created_at),
  INDEX idx_order_print_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
