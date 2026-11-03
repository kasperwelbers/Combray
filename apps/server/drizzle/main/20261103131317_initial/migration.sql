CREATE TABLE `donations` (
	`id` text PRIMARY KEY,
	`project` text NOT NULL,
	`day` text NOT NULL,
	`bytes` integer NOT NULL,
	`withdrawal_hash` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `handoffs` (
	`code_hash` blob PRIMARY KEY,
	`researcher_id` text NOT NULL,
	`expires` integer NOT NULL,
	CONSTRAINT `fk_handoffs_researcher_id_researchers_id_fk` FOREIGN KEY (`researcher_id`) REFERENCES `researchers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `login_codes` (
	`request_hash` blob PRIMARY KEY,
	`researcher_id` text,
	`code_hash` blob NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`expires` integer NOT NULL,
	CONSTRAINT `fk_login_codes_researcher_id_researchers_id_fk` FOREIGN KEY (`researcher_id`) REFERENCES `researchers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `members` (
	`project` text NOT NULL,
	`researcher_id` text NOT NULL,
	`sealed_enc` blob,
	`sealed_ct` blob,
	`added` integer NOT NULL,
	CONSTRAINT `members_pk` PRIMARY KEY(`project`, `researcher_id`),
	CONSTRAINT `fk_members_researcher_id_researchers_id_fk` FOREIGN KEY (`researcher_id`) REFERENCES `researchers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY,
	`researcher_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`name` text NOT NULL,
	`wrapped_master` blob,
	`created` integer NOT NULL,
	`last_used` integer,
	CONSTRAINT `fk_passkeys_researcher_id_researchers_id_fk` FOREIGN KEY (`researcher_id`) REFERENCES `researchers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_keys` (
	`project` text PRIMARY KEY,
	`public_key` blob NOT NULL,
	`fingerprint` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `researchers` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL UNIQUE,
	`created` integer NOT NULL,
	`public_key` blob,
	`recovery_verifier` blob
);
--> statement-breakpoint
CREATE TABLE `reset_tokens` (
	`token_hash` blob PRIMARY KEY,
	`project_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` blob PRIMARY KEY,
	`researcher_id` text NOT NULL,
	`site` text NOT NULL,
	`level` text NOT NULL,
	`expires` integer NOT NULL,
	CONSTRAINT `fk_sessions_researcher_id_researchers_id_fk` FOREIGN KEY (`researcher_id`) REFERENCES `researchers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`participant_id` text,
	`kek_salt` blob NOT NULL,
	`pw_salt` blob NOT NULL,
	`pw_hash` blob NOT NULL,
	`delete_hash` blob NOT NULL,
	`m_kib` integer NOT NULL,
	`t_cost` integer NOT NULL,
	`p_cost` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tombstones` (
	`id` text PRIMARY KEY,
	`project` text NOT NULL,
	`day` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `donations_project` ON `donations` (`project`);--> statement-breakpoint
CREATE INDEX `members_researcher` ON `members` (`researcher_id`);--> statement-breakpoint
CREATE INDEX `passkeys_researcher` ON `passkeys` (`researcher_id`);