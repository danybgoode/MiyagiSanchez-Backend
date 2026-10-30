import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Index in_person_sale.cart_id (in-person-sales S2).
 *
 * start-checkout now looks EVERY cart up in this table by id — the only proof a cart is
 * a counter cart, since cart metadata is client-writable (codex, PR 218) — and the
 * completeCart validate hook does the same on every completion. Applied on boot by
 * `update.sh` (D18); additive, no data premise.
 */
export class Migration20261030120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_in_person_sale_cart_id" ON "in_person_sale" ("cart_id") WHERE cart_id IS NOT NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_in_person_sale_cart_id";`);
  }

}
