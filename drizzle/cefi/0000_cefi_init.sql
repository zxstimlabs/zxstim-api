CREATE TABLE `cefi_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `cefi_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cefi_account_userId_idx` ON `cefi_account` (`user_id`);--> statement-breakpoint
CREATE TABLE `cefi_passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `cefi_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cefi_passkey_userId_idx` ON `cefi_passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `cefi_passkey_credentialID_idx` ON `cefi_passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `cefi_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `cefi_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cefi_session_token_unique` ON `cefi_session` (`token`);--> statement-breakpoint
CREATE INDEX `cefi_session_userId_idx` ON `cefi_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `cefi_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`username` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cefi_user_email_unique` ON `cefi_user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `cefi_user_username_unique` ON `cefi_user` (`username`);