import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * payment_link + payment_link_cart — «Cobrar con un link» (in-person-sales S4, D13/D15).
 *
 * How this gets applied: Medusa migrates on boot when `update.sh` starts the new
 * backend image (D18). Both tables are new and empty — no data premise.
 */
export class Migration20261031120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "payment_link" ("id" text not null, "seller_id" text not null, "token" text not null, "kind" text not null, "lines" jsonb null, "concept" text null, "amount_cents" integer null, "uses" text not null, "expires_at" timestamptz not null, "status" text not null, "paid_order_ids" jsonb null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_link_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_link_token_unique" ON "payment_link" ("token");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_link_seller_id" ON "payment_link" ("seller_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_link_deleted_at" ON "payment_link" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`create table if not exists "payment_link_cart" ("id" text not null, "payment_link_id" text not null, "cart_id" text not null, "seller_id" text not null, "total_cents" integer not null, "payload_hash" text not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_link_cart_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_link_cart_cart_id_unique" ON "payment_link_cart" ("cart_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_link_cart_payment_link_id" ON "payment_link_cart" ("payment_link_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_link_cart_deleted_at" ON "payment_link_cart" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "payment_link_cart" cascade;`);
    this.addSql(`drop table if exists "payment_link" cascade;`);
  }

}
