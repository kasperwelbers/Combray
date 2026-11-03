CREATE TABLE `project_details` (
	`project_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text,
	`participants_mode` text DEFAULT 'optional' NOT NULL,
	`participants_pattern` text,
	CONSTRAINT `fk_project_details_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_platforms` (
	`project_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`pack` text,
	`position` integer DEFAULT 0 NOT NULL,
	`structure` text,
	`importer` text,
	CONSTRAINT `project_platforms_pk` PRIMARY KEY(`project_id`, `id`),
	CONSTRAINT `fk_project_platforms_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`created` integer NOT NULL,
	`draft_updated` integer NOT NULL,
	`draft_revision` integer DEFAULT 1 NOT NULL,
	`published_revision` integer DEFAULT 0 NOT NULL,
	`live` text,
	`live_version` integer DEFAULT 0 NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
-- Projects that already have members or a key (from before projects were stored) get a record,
-- so the foreign keys below hold. Their name is their id until a researcher sets one.
INSERT OR IGNORE INTO `projects` (`id`, `created`, `draft_updated`) SELECT `project`, unixepoch(), unixepoch() FROM `members` UNION SELECT `project`, unixepoch(), unixepoch() FROM `project_keys`;--> statement-breakpoint
INSERT OR IGNORE INTO `project_details` (`project_id`, `name`) SELECT `id`, json_quote(`id`) FROM `projects`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_members` (
	`project` text NOT NULL,
	`researcher_id` text NOT NULL,
	`sealed_enc` blob,
	`sealed_ct` blob,
	`added` integer NOT NULL,
	CONSTRAINT `members_pk` PRIMARY KEY(`project`, `researcher_id`),
	CONSTRAINT `fk_members_project_projects_id_fk` FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_members_researcher_id_researchers_id_fk` FOREIGN KEY (`researcher_id`) REFERENCES `researchers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_members`(`project`, `researcher_id`, `sealed_enc`, `sealed_ct`, `added`) SELECT `project`, `researcher_id`, `sealed_enc`, `sealed_ct`, `added` FROM `members`;--> statement-breakpoint
DROP TABLE `members`;--> statement-breakpoint
ALTER TABLE `__new_members` RENAME TO `members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_keys` (
	`project` text PRIMARY KEY,
	`public_key` blob NOT NULL,
	`fingerprint` text NOT NULL,
	`created` integer NOT NULL,
	CONSTRAINT `fk_project_keys_project_projects_id_fk` FOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_project_keys`(`project`, `public_key`, `fingerprint`, `created`) SELECT `project`, `public_key`, `fingerprint`, `created` FROM `project_keys`;--> statement-breakpoint
DROP TABLE `project_keys`;--> statement-breakpoint
ALTER TABLE `__new_project_keys` RENAME TO `project_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `members_researcher` ON `members` (`researcher_id`);