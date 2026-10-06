import { z } from "zod";

import { db } from "~/server/db";
import type { PosCaller } from "./guard";

/**
 * Receiving a till's catalogue.
 *
 * The body is the POS's own change-set format (Pos.Core.Sync.SyncChangeSet) —
 * the same rows one till hands another in a merge — limited to the Categories
 * and Products tables. Using that format rather than a purpose-built one means
 * the till has one way of saying "these rows changed", and the later sales
 * upload and till-to-till cloud sync travel the same pipe.
 *
 * In that format every row is identified by its GlobalId, foreign keys are
 * GlobalIds too, and `UpdatedAt` is UTC text, "yyyy-MM-dd HH:mm:ss.fffffff".
 *
 * See Epos365/POS_INTEGRATION_ARCHITECTURE.md §5.3.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** One push. A real catalogue seen so far is ~1,200 products; this leaves room and still bounds the transaction. */
const MAX_ROWS = 10_000;
/** A row stamped further ahead than this is refused: a till with a wrong clock would otherwise win every later edit. */
const MAX_CLOCK_AHEAD_MS = 10 * 60 * 1000;
/** A push that would take more than this share of the live menu offline is held for the owner. */
const DESTRUCTIVE_SHARE = 0.2;
/** Below this many live items the share is too jumpy to mean anything (removing 1 of 3 is 33%). */
const DESTRUCTIVE_MIN_LIVE = 10;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The till's timestamp format, exactly. Compared as text, so the shape has to be exact. */
const POS_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/;

/** .NET writes PascalCase and this codebase reads either, as the licensing endpoints do. */
function lowerKeys(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key.toLowerCase()] = inner;
  return out;
}

const text = z.string().trim().min(1);
/** SQLite has no boolean type, so the till sends 0/1; a JSON boolean is accepted too. */
const flag = z.union([z.boolean(), z.number()]).transform((v) => v === true || v === 1);

const categoryValues = z.object({
  name: text.max(200),
  parentid: z.string().nullish(),
  sortorder: z.number().int().catch(0),
  hidden: flag.catch(false),
  updatedat: z.string().regex(POS_TIMESTAMP),
});

const productValues = z.object({
  name: text.max(200),
  categoryid: text,
  price: z.number().nonnegative().finite(),
  active: flag.catch(true),
  sortorder: z.number().int().catch(0),
  description: z.string().max(2000).nullish(),
  isweightbased: flag.catch(false),
  isopenprice: flag.catch(false),
  /** Absent on a till that predates the "sell online" switch, which means every product is offered. */
  showonline: flag.catch(true),
  imagehash: z.string().max(128).nullish(),
  updatedat: z.string().regex(POS_TIMESTAMP),
});

const envelope = z.object({
  formatversion: z.literal(1),
  lineage: text.max(100),
  tables: z.array(z.unknown()).default([]),
  deletions: z.array(z.unknown()).default([]),
  /** Set only when the shop's owner has confirmed a push that was held. */
  confirmdestructive: z.boolean().default(false),
});

interface CategoryRow {
  posId: string;
  name: string;
  parentPosId: string | null;
  sortOrder: number;
  active: boolean;
  posUpdatedAt: string;
}

interface ItemRow {
  posId: string;
  categoryPosId: string;
  name: string;
  description: string | null;
  priceCents: number;
  active: boolean;
  sortOrder: number;
  imageHash: string | null;
  posUpdatedAt: string;
}

interface Tombstone {
  posId: string;
  deletedAt: string;
}

interface ParsedPush {
  lineage: string;
  confirmDestructive: boolean;
  categories: CategoryRow[];
  items: ItemRow[];
  deletedCategories: Tombstone[];
  deletedItems: Tombstone[];
  /** Rows that were sent but cannot be taken, with why. Reported back; never silently dropped. */
  rejected: { table: string; posId: string; reason: string }[];
}

export type ParseResult = { ok: true; push: ParsedPush } | { ok: false; error: string };

/** UTC text from the till → epoch ms. The format carries no zone marker because it is always UTC. */
function posTimestampMs(value: string): number {
  return Date.parse(`${value.slice(0, 10)}T${value.slice(11, 23)}Z`);
}

export function parsePush(body: unknown, now = Date.now()): ParseResult {
  const parsed = envelope.safeParse(lowerKeys(body));
  if (!parsed.success) {
    return {
      ok: false,
      error: `Not a catalogue change set: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
    };
  }

  const push: ParsedPush = {
    lineage: parsed.data.lineage,
    confirmDestructive: parsed.data.confirmdestructive,
    categories: [],
    items: [],
    deletedCategories: [],
    deletedItems: [],
    rejected: [],
  };
  const tooFarAhead = (stamp: string) => posTimestampMs(stamp) > now + MAX_CLOCK_AHEAD_MS;
  let rowCount = 0;

  for (const rawTable of parsed.data.tables) {
    const table = lowerKeys(rawTable);
    const name = typeof table.table === "string" ? table.table.toLowerCase() : "";
    if (name !== "categories" && name !== "products") continue; // other tables are not this endpoint's business
    const rows = Array.isArray(table.rows) ? table.rows : [];
    rowCount += rows.length;
    if (rowCount > MAX_ROWS) return { ok: false, error: `More than ${MAX_ROWS} rows in one push.` };

    for (const rawRow of rows) {
      const row = lowerKeys(rawRow);
      const posId = typeof row.globalid === "string" ? row.globalid.trim() : "";
      if (!posId) {
        push.rejected.push({ table: name, posId: "", reason: "row has no GlobalId" });
        continue;
      }
      const reject = (reason: string) => push.rejected.push({ table: name, posId, reason });

      if (name === "categories") {
        const values = categoryValues.safeParse(lowerKeys(row.values));
        if (!values.success) {
          reject(`${values.error.issues[0]?.path.join(".")}: ${values.error.issues[0]?.message}`);
          continue;
        }
        if (tooFarAhead(values.data.updatedat)) {
          reject("UpdatedAt is in the future — check this till's clock");
          continue;
        }
        push.categories.push({
          posId,
          name: values.data.name,
          parentPosId: values.data.parentid?.trim() ?? null,
          sortOrder: values.data.sortorder,
          active: !values.data.hidden,
          posUpdatedAt: values.data.updatedat,
        });
      } else {
        const values = productValues.safeParse(lowerKeys(row.values));
        if (!values.success) {
          reject(`${values.error.issues[0]?.path.join(".")}: ${values.error.issues[0]?.message}`);
          continue;
        }
        if (tooFarAhead(values.data.updatedat)) {
          reject("UpdatedAt is in the future — check this till's clock");
          continue;
        }
        const v = values.data;
        push.items.push({
          posId,
          categoryPosId: v.categoryid,
          name: v.name,
          description: v.description?.trim() ? v.description.trim() : null,
          // The till's Price is always the gross shelf price (see Product.Price in Pos.Core).
          priceCents: Math.round(v.price * 100),
          // Whatever the till says, a product sold by weight or at a price typed at the till
          // has no fixed online price, so it is never offered online. Enforced here as well as
          // on the till: this is the side that cannot be bypassed.
          active: v.active && v.showonline && !v.isweightbased && !v.isopenprice,
          sortOrder: v.sortorder,
          imageHash: v.imagehash ?? null,
          posUpdatedAt: v.updatedat,
        });
      }
    }
  }

  for (const rawDeletion of parsed.data.deletions) {
    const deletion = lowerKeys(rawDeletion);
    const name = typeof deletion.table === "string" ? deletion.table.toLowerCase() : "";
    if (name !== "categories" && name !== "products") continue;
    const posId = typeof deletion.globalid === "string" ? deletion.globalid.trim() : "";
    const deletedAt = typeof deletion.deletedat === "string" ? deletion.deletedat : "";
    if (!posId || !POS_TIMESTAMP.test(deletedAt)) {
      push.rejected.push({ table: name, posId, reason: "deletion needs a GlobalId and a DeletedAt" });
      continue;
    }
    if (tooFarAhead(deletedAt)) {
      push.rejected.push({ table: name, posId, reason: "DeletedAt is in the future — check this till's clock" });
      continue;
    }
    (name === "categories" ? push.deletedCategories : push.deletedItems).push({ posId, deletedAt });
    if (++rowCount > MAX_ROWS) return { ok: false, error: `More than ${MAX_ROWS} rows in one push.` };
  }

  return { ok: true, push };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export type PushOutcome =
  | {
      kind: "applied";
      version: number;
      applied: { categories: number; items: number; deletedCategories: number; deletedItems: number };
      /** Rows this server already held a newer or equal version of. Not an error: last write wins. */
      stale: number;
      rejected: ParsedPush["rejected"];
    }
  | { kind: "held"; heldId: string; reason: string; rejected: ParsedPush["rejected"] }
  | { kind: "refused"; status: 403 | 409; code: string; error: string };

/** The two calls this module makes inside a transaction. `db` is an extended client, so its transaction handle is not `Prisma.TransactionClient`. */
type Tx = Pick<typeof db, "$executeRaw" | "$queryRaw">;

/** Bigint columns come back as JS bigint; everything this module counts fits a number. */
const n = (value: unknown) => Number(value ?? 0);

async function log(tx: Tx, caller: PosCaller, kind: string, detail: Record<string, unknown>) {
  await tx.$executeRaw`
    INSERT INTO pos_sync.sync_log ("shopId", "deviceRowId", "kind", "detail")
    VALUES (${caller.shopId}, ${caller.deviceRowId}, ${kind}, ${JSON.stringify(detail)}::jsonb)`;
}

/**
 * Whether this till may publish. The first till ever to publish for a shop is
 * given the right, so a single-till shop needs no setup; from then on only a
 * till the owner has granted it to may. Checked across every licence the shop
 * holds, since the right belongs to the shop's catalogue, not to one licence.
 */
async function ensurePublisher(tx: Tx, caller: PosCaller): Promise<boolean> {
  if (caller.canPublishCatalog) return true;

  const [existing] = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count
    FROM public."Device" d JOIN public."License" l ON l."id" = d."licenseId"
    WHERE l."shopId" = ${caller.shopId} AND d."canPublishCatalog"`;
  if (n(existing?.count) > 0) return false;

  await tx.$executeRaw`UPDATE public."Device" SET "canPublishCatalog" = true WHERE "id" = ${caller.deviceRowId}`;
  await log(tx, caller, "publisher_granted", { why: "first till to publish for this shop" });
  return true;
}

/**
 * How many currently-live items this push would take off the menu: deleted, or
 * newly inactive, and newer than what is staged (so it would actually apply).
 */
async function wouldRemove(tx: Tx, shopId: string, push: ParsedPush): Promise<{ live: number; removed: number }> {
  const [live] = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pos_sync.catalog_item
    WHERE "shopId" = ${shopId} AND "deletedAt" IS NULL AND "active"`;

  const goingInactive = push.items.filter((i) => !i.active).map((i) => ({ posId: i.posId, stamp: i.posUpdatedAt }));
  const goingDeleted = push.deletedItems.map((d) => ({ posId: d.posId, stamp: d.deletedAt }));
  const candidates = [...goingInactive, ...goingDeleted];
  if (candidates.length === 0) return { live: n(live?.count), removed: 0 };

  const [removed] = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT count(DISTINCT t."posId") AS count
    FROM pos_sync.catalog_item t
    JOIN jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb) AS x("posId" text, "stamp" text)
      ON x."posId" = t."posId"
    WHERE t."shopId" = ${shopId} AND t."deletedAt" IS NULL AND t."active" AND x."stamp" >= t."posUpdatedAt"`;
  return { live: n(live?.count), removed: n(removed?.count) };
}

/**
 * Applies one push for one shop, in one transaction.
 *
 * Last write wins, on the till's own `UpdatedAt`, exactly as the tills resolve
 * it between themselves. That is what makes it safe for two tills to publish:
 * a till holding an older copy of a product cannot overwrite a newer edit,
 * whatever order the pushes arrive in.
 */
export async function applyPush(caller: PosCaller, push: ParsedPush): Promise<PushOutcome> {
  const { shopId } = caller;

  return db.$transaction(
    async (tx): Promise<PushOutcome> => {
      if (!(await ensurePublisher(tx, caller))) {
        return {
          kind: "refused",
          status: 403,
          code: "not_publisher",
          error: "This till is not allowed to publish the catalogue. The shop's owner chooses which till may.",
        };
      }

      // Creates the shop's row on its first push, then locks it: a second push for the same
      // shop waits here until this one commits, so versions are handed out one at a time.
      await tx.$executeRaw`
        INSERT INTO pos_sync.catalog_state ("shopId", "version", "lineageId")
        VALUES (${shopId}, 0, ${push.lineage}) ON CONFLICT ("shopId") DO NOTHING`;
      const [state] = await tx.$queryRaw<{ version: bigint; lineageId: string }[]>`
        SELECT "version", "lineageId" FROM pos_sync.catalog_state WHERE "shopId" = ${shopId} FOR UPDATE`;
      if (!state) throw new Error("catalog_state row vanished inside its own transaction");

      if (state.lineageId !== push.lineage) {
        await log(tx, caller, "push_refused_lineage", { expected: state.lineageId, got: push.lineage });
        return {
          kind: "refused",
          status: 409,
          code: "different_lineage",
          error:
            "This till's database was not set up from this shop's data, so its products have different identities. " +
            "Publishing from it would add the whole menu a second time. Set the till up by restoring a backup of the shop's main till.",
        };
      }

      if (!push.confirmDestructive) {
        const { live, removed } = await wouldRemove(tx, shopId, push);
        if (live >= DESTRUCTIVE_MIN_LIVE && removed > live * DESTRUCTIVE_SHARE) {
          const reason = `Would take ${removed} of ${live} items off the online menu.`;
          const [held] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO pos_sync.catalog_held_push ("shopId", "deviceRowId", "reason", "payload")
            VALUES (${shopId}, ${caller.deviceRowId}, ${reason}, ${JSON.stringify(push)}::jsonb)
            RETURNING "id"::text AS id`;
          await log(tx, caller, "push_held", { heldId: held?.id, live, removed });
          return { kind: "held", heldId: held?.id ?? "", reason, rejected: push.rejected };
        }
      }

      const version = n(state.version) + 1;

      // One statement per table, whatever the size of the push: a per-row upsert of a
      // 1,200-product catalogue is 1,200 round trips and runs past the transaction timeout.
      const categories =
        push.categories.length === 0
          ? 0
          : await tx.$executeRaw`
              INSERT INTO pos_sync.catalog_category AS t
                ("shopId", "posId", "name", "parentPosId", "sortOrder", "active", "posUpdatedAt", "deletedAt", "changedVersion")
              SELECT ${shopId}, x."posId", x."name", x."parentPosId", x."sortOrder", x."active", x."posUpdatedAt", NULL, ${version}
              FROM jsonb_to_recordset(${JSON.stringify(push.categories)}::jsonb)
                AS x("posId" text, "name" text, "parentPosId" text, "sortOrder" int, "active" boolean, "posUpdatedAt" text)
              ON CONFLICT ("shopId", "posId") DO UPDATE SET
                "name" = EXCLUDED."name", "parentPosId" = EXCLUDED."parentPosId", "sortOrder" = EXCLUDED."sortOrder",
                "active" = EXCLUDED."active", "posUpdatedAt" = EXCLUDED."posUpdatedAt", "deletedAt" = NULL,
                "changedVersion" = EXCLUDED."changedVersion"
              WHERE EXCLUDED."posUpdatedAt" > t."posUpdatedAt"
                 OR (EXCLUDED."posUpdatedAt" = t."posUpdatedAt" AND t."deletedAt" IS NOT NULL)`;

      const items =
        push.items.length === 0
          ? 0
          : await tx.$executeRaw`
              INSERT INTO pos_sync.catalog_item AS t
                ("shopId", "posId", "categoryPosId", "name", "description", "priceCents", "active", "sortOrder", "imageHash",
                 "posUpdatedAt", "deletedAt", "changedVersion")
              SELECT ${shopId}, x."posId", x."categoryPosId", x."name", x."description", x."priceCents", x."active", x."sortOrder",
                     x."imageHash", x."posUpdatedAt", NULL, ${version}
              FROM jsonb_to_recordset(${JSON.stringify(push.items)}::jsonb)
                AS x("posId" text, "categoryPosId" text, "name" text, "description" text, "priceCents" int, "active" boolean,
                     "sortOrder" int, "imageHash" text, "posUpdatedAt" text)
              ON CONFLICT ("shopId", "posId") DO UPDATE SET
                "categoryPosId" = EXCLUDED."categoryPosId", "name" = EXCLUDED."name", "description" = EXCLUDED."description",
                "priceCents" = EXCLUDED."priceCents", "active" = EXCLUDED."active", "sortOrder" = EXCLUDED."sortOrder",
                "imageHash" = EXCLUDED."imageHash", "posUpdatedAt" = EXCLUDED."posUpdatedAt", "deletedAt" = NULL,
                "changedVersion" = EXCLUDED."changedVersion"
              WHERE EXCLUDED."posUpdatedAt" > t."posUpdatedAt"
                 OR (EXCLUDED."posUpdatedAt" = t."posUpdatedAt" AND t."deletedAt" IS NOT NULL)`;

      // A deletion loses to an edit made after it, the same rule the tills use between themselves.
      const deletedCategories =
        push.deletedCategories.length === 0
          ? 0
          : await tx.$executeRaw`
              UPDATE pos_sync.catalog_category t
              SET "deletedAt" = x."deletedAt", "changedVersion" = ${version}
              FROM jsonb_to_recordset(${JSON.stringify(push.deletedCategories)}::jsonb) AS x("posId" text, "deletedAt" text)
              WHERE t."shopId" = ${shopId} AND t."posId" = x."posId" AND t."deletedAt" IS NULL AND x."deletedAt" >= t."posUpdatedAt"`;

      const deletedItems =
        push.deletedItems.length === 0
          ? 0
          : await tx.$executeRaw`
              UPDATE pos_sync.catalog_item t
              SET "deletedAt" = x."deletedAt", "changedVersion" = ${version}
              FROM jsonb_to_recordset(${JSON.stringify(push.deletedItems)}::jsonb) AS x("posId" text, "deletedAt" text)
              WHERE t."shopId" = ${shopId} AND t."posId" = x."posId" AND t."deletedAt" IS NULL AND x."deletedAt" >= t."posUpdatedAt"`;

      const changed = categories + items + deletedCategories + deletedItems;
      const sent = push.categories.length + push.items.length + push.deletedCategories.length + push.deletedItems.length;

      // The version only moves when something actually changed, so a till re-sending what the
      // server already has does not make the website re-apply an identical catalogue.
      if (changed > 0) {
        await tx.$executeRaw`
          UPDATE pos_sync.catalog_state SET "version" = ${version}, "updatedAt" = now() WHERE "shopId" = ${shopId}`;
      }
      await log(tx, caller, "catalog_push", {
        version: changed > 0 ? version : n(state.version),
        categories,
        items,
        deletedCategories,
        deletedItems,
        stale: sent - changed,
        rejected: push.rejected.length,
      });

      return {
        kind: "applied",
        version: changed > 0 ? version : n(state.version),
        applied: { categories, items, deletedCategories, deletedItems },
        stale: sent - changed,
        rejected: push.rejected,
      };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
