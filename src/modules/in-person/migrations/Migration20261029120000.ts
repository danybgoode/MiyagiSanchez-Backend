import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * in_person_sale — the exactly-once claim ledger for counter sales (in-person-sales D4).
 *
 * How this gets applied: Medusa runs module migrations on boot, so this lands when
 * `update.sh` starts the new backend image (D18). The table is new and empty, so it
 * carries no data premise. The UNIQUE index on (seller_id, client_id) is not
 * partial on deleted_at on purpose: a soft-deleted claim must still block a replay.
 */
export class Migration20261029120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "in_person_sale" ("id" text not null, "seller_id" text not null, "client_id" text not null, "kind" text not null, "status" text not null, "payload_hash" text not null, "cart_id" text null, "order_id" text null, "offline" boolean not null default false, "oversold" boolean not null default false, "claimed_at" timestamptz not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "in_person_sale_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_in_person_sale_deleted_at" ON "in_person_sale" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_in_person_sale_seller_id_client_id_unique" ON "in_person_sale" ("seller_id", "client_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_in_person_sale_seller_id" ON "in_person_sale" ("seller_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "in_person_sale" cascade;`);
  }

}
