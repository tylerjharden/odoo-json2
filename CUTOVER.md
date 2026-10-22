# Cutover from Blob to Neon

Production reads and writes the OAuth store in Neon through `DATABASE_URL`. The old Blob document was not imported into Neon. A client, a token, or a connected account that exists only in that document does not work against production until you import it.

`odoo-json2 store sync` is the import. The command and its rules are in [Move the OAuth store](README.md#move-the-oauth-store).

## Import the Blob document into Neon

Run these steps from a checkout of this repository after `npm ci`.

1. Read the old Blob token into the shell. `read -rs` keeps the value off the screen and out of shell history.

   ```bash
   read -rs LEGACY_BLOB_TOKEN && export LEGACY_BLOB_TOKEN
   ```

2. Copy the production connection string from the Neon console, and read it into `DATABASE_URL` the same way.

   ```bash
   read -rs DATABASE_URL && export DATABASE_URL
   ```

3. Preview the import. The preview writes nothing.

   ```bash
   node bin/odoo-json2.mjs store sync --from blob:token=LEGACY_BLOB_TOKEN --to postgres
   ```

4. Read the preview. A `!` line is a record that Blob and Neon both hold with different values. To keep the value that production wrote, add `--prefer target`. To take the Blob value, add `--prefer source`.
5. Run the same command with `--apply`. The run ends with `Wrote N records` and `Verified N of N`.
6. Run the `--apply` command again. It ends with `Nothing to change.` If it lists records instead, run it once more.

The server and the CLI both replace the whole document when they write. A login that the server writes in the moment between the CLI's last read and its write is lost, and that user connects again. A server write that started before the CLI's write can also drop imported records. Step 6 finds those records and copies them again.

## Roll back to Blob

The server picks Blob over `DATABASE_URL` whenever `BLOB_READ_WRITE_TOKEN` is set. A rollback needs no code change.

1. To keep the records that production wrote to Neon, copy them into Blob first. Read `LEGACY_BLOB_TOKEN` and `DATABASE_URL` into the shell as in the import steps. If a record differs, add `--prefer source` to keep the Neon value.

   ```bash
   node bin/odoo-json2.mjs store sync --from postgres --to blob:token=LEGACY_BLOB_TOKEN --apply
   ```

2. Set `BLOB_READ_WRITE_TOKEN` for production. Paste the old Blob token at the prompt.

   ```bash
   vercel env add BLOB_READ_WRITE_TOKEN production
   ```

3. Redeploy production. The server reads the new variable only in a new deployment.
