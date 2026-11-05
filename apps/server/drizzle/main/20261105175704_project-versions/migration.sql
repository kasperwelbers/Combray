CREATE TABLE `project_versions` (
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`config` text NOT NULL,
	`published_at` integer NOT NULL,
	CONSTRAINT `project_versions_pk` PRIMARY KEY(`project_id`, `version`),
	CONSTRAINT `fk_project_versions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Projects published before versions were kept: their live version is the first one kept.
INSERT INTO `project_versions` (`project_id`, `version`, `config`, `published_at`)
SELECT `id`, `live_version`, `live`, `published_at` FROM `projects` WHERE `live` IS NOT NULL AND `published_at` IS NOT NULL;
