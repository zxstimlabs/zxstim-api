CREATE TABLE `indexer_cursor` (
	`pool_id` text PRIMARY KEY NOT NULL,
	`last_indexed_block` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pool_meta` (
	`pool_id` text PRIMARY KEY NOT NULL,
	`currency0_symbol` text NOT NULL,
	`currency1_symbol` text NOT NULL,
	`currency0_decimals` integer NOT NULL,
	`currency1_decimals` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pool_states` (
	`pool_id` text NOT NULL,
	`block_number` integer NOT NULL,
	`block_timestamp` integer NOT NULL,
	`sqrt_price_x96` text NOT NULL,
	`tick` integer NOT NULL,
	`protocol_fee` integer NOT NULL,
	`lp_fee` integer NOT NULL,
	`liquidity` text NOT NULL,
	`fee_growth_global_0` text NOT NULL,
	`fee_growth_global_1` text NOT NULL,
	`reserve0` text NOT NULL,
	`reserve1` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`pool_id`, `block_number`)
);
--> statement-breakpoint
CREATE TABLE `swaps` (
	`tx_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`pool_id` text NOT NULL,
	`block_number` integer NOT NULL,
	`block_timestamp` integer NOT NULL,
	`sender` text NOT NULL,
	`user_address` text NOT NULL,
	`amount0` text NOT NULL,
	`amount1` text NOT NULL,
	`sqrt_price_x96` text NOT NULL,
	`liquidity` text NOT NULL,
	`tick` integer NOT NULL,
	`fee` integer NOT NULL,
	`price` real NOT NULL,
	PRIMARY KEY(`tx_hash`, `log_index`)
);
--> statement-breakpoint
CREATE INDEX `swaps_pool_ts_idx` ON `swaps` (`pool_id`,`block_timestamp`);--> statement-breakpoint
CREATE INDEX `swaps_pool_block_idx` ON `swaps` (`pool_id`,`block_number`);--> statement-breakpoint
CREATE INDEX `swaps_pool_user_idx` ON `swaps` (`pool_id`,`user_address`);