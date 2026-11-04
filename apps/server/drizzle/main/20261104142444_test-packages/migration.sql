CREATE TABLE `test_packages` (
	`project_id` text NOT NULL,
	`platform_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`structure_hash` text NOT NULL,
	`shape` text NOT NULL,
	`data` blob,
	`data_bytes` integer DEFAULT 0 NOT NULL,
	`added_by` text,
	`added` integer NOT NULL,
	CONSTRAINT `test_packages_pk` PRIMARY KEY(`project_id`, `platform_id`, `id`),
	CONSTRAINT `fk_test_packages_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_test_packages_added_by_researchers_id_fk` FOREIGN KEY (`added_by`) REFERENCES `researchers`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_packages_structure_name` ON `test_packages` (`project_id`,`platform_id`,`structure_hash`,`name`);