import Link from "next/link";
import { notFound } from "next/navigation";

import { Notice, readNotice } from "~/app/_components/notice";
import { centsToInputValue } from "~/app/_lib/format";
import { deleteHardwareItemAction, updateHardwareItemAction } from "~/server/actions/pricing";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

export default async function EditHardwareItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { notice, tone } = readNotice(await searchParams);

  const item = await db.hardwareItem.findUnique({ where: { id } });
  if (!item) notFound();

  return (
    <section className="vbg-section">
      <p className="vbg-meta">
        <Link href="/pricing">Pricing</Link>
      </p>
      <h1 className="vbg-title">Edit hardware item</h1>

      <Notice notice={notice} tone={tone} />

      <form action={updateHardwareItemAction} className="vbg-span-7">
        <input type="hidden" name="id" value={item.id} />

        <div className="vbg-custom-form-row">
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="name">
              Name
            </label>
            <input id="name" name="name" type="text" defaultValue={item.name} required />
          </div>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="note">
              Note (optional)
            </label>
            <input id="note" name="note" type="text" defaultValue={item.note ?? ""} />
          </div>
        </div>

        <div className="vbg-custom-form-row" style={{ marginTop: "var(--vbg-space-4)" }}>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="oneTime">
              One-time (€)
            </label>
            <input
              id="oneTime"
              name="oneTime"
              type="text"
              inputMode="decimal"
              defaultValue={centsToInputValue(item.oneTimeCents)}
            />
          </div>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="monthly">
              Monthly (€)
            </label>
            <input
              id="monthly"
              name="monthly"
              type="text"
              inputMode="decimal"
              defaultValue={centsToInputValue(item.monthlyCents)}
            />
          </div>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="yearly">
              Yearly (€)
            </label>
            <input
              id="yearly"
              name="yearly"
              type="text"
              inputMode="decimal"
              defaultValue={centsToInputValue(item.yearlyCents)}
            />
          </div>
        </div>

        <div className="vbg-custom-form-row" style={{ marginTop: "var(--vbg-space-4)" }}>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="minQuantity">
              Min quantity
            </label>
            <input
              id="minQuantity"
              name="minQuantity"
              type="number"
              min={0}
              max={50}
              defaultValue={item.minQuantity}
            />
            <p className="vbg-helper">Above 0 makes it always-on and not removable.</p>
          </div>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="maxQuantity">
              Max quantity
            </label>
            <input
              id="maxQuantity"
              name="maxQuantity"
              type="number"
              min={0}
              max={50}
              defaultValue={item.maxQuantity}
            />
          </div>
        </div>

        <div className="vbg-custom-actions" style={{ marginTop: "var(--vbg-space-6)" }}>
          <button type="submit" className="vbg-button">
            Save
          </button>
        </div>
      </form>

      <form action={deleteHardwareItemAction} style={{ marginTop: "var(--vbg-space-6)" }}>
        <input type="hidden" name="id" value={item.id} />
        <button type="submit" className="vbg-button">
          Delete this item
        </button>
      </form>
    </section>
  );
}
