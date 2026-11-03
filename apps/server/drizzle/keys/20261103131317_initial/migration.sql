CREATE TABLE `sealed_keys` (
	`donation` text PRIMARY KEY,
	`project` text NOT NULL,
	`fingerprint` text NOT NULL,
	`enc` blob NOT NULL,
	`ciphertext` blob NOT NULL
);
