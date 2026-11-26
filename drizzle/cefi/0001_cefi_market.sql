CREATE TABLE `cefi_balance` (
	`user_id` text PRIMARY KEY NOT NULL,
	`vnd` integer NOT NULL,
	`eth` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cefi_book_order` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`price` integer NOT NULL,
	`quantity` integer NOT NULL,
	`remaining` integer NOT NULL,
	`status` text NOT NULL,
	`sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cefi_book_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`mid` integer NOT NULL,
	`id_seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cefi_candle` (
	`resolution` text NOT NULL,
	`t` integer NOT NULL,
	`open` integer NOT NULL,
	`high` integer NOT NULL,
	`low` integer NOT NULL,
	`close` integer NOT NULL,
	`volume` integer NOT NULL,
	`quote_vnd` integer NOT NULL,
	PRIMARY KEY(`resolution`, `t`)
);
--> statement-breakpoint
CREATE TABLE `cefi_fill` (
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`order_id` integer NOT NULL,
	`side` text NOT NULL,
	`price` integer NOT NULL,
	`quantity` integer NOT NULL,
	`quote` integer NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `seq`, `role`)
);
--> statement-breakpoint
CREATE TABLE `cefi_order` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`side` text NOT NULL,
	`type` text NOT NULL,
	`price` integer,
	`quantity` integer NOT NULL,
	`filled` integer NOT NULL,
	`quote` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cefi_order_user_idx` ON `cefi_order` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `cefi_order_status_idx` ON `cefi_order` (`status`);--> statement-breakpoint
CREATE TABLE `cefi_trade` (
	`seq` integer PRIMARY KEY NOT NULL,
	`price` integer NOT NULL,
	`quantity` integer NOT NULL,
	`taker_side` text NOT NULL,
	`maker_order_id` text NOT NULL,
	`taker_order_id` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cefi_trade_at_idx` ON `cefi_trade` (`at`);