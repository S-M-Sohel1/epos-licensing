"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The panel's section navigation.
 *
 * The only client component in the app, and only because marking the current
 * section needs the live pathname. Everything it renders is still plain links,
 * so it works before hydration.
 */
export function SidebarNav({
  pendingCount,
  quoteCount,
  crashCount,
}: {
  pendingCount: number;
  quoteCount: number;
  crashCount: number;
}) {
  const pathname = usePathname();

  // In order of how often the operator acts on each, in three groups with a rule between them:
  // what is waiting on someone, support, and set-up that rarely changes. Releases is last: the
  // developer publishes till versions there, not the operator.
  // A count's capsule says how urgent it is: plain for a queue, blue for new requests to ring back,
  // red for crashes.
  const items: { href: string; label: string; count?: number; tone?: "new" | "alert"; groupStart?: boolean }[] = [
    { href: "/", label: "Approvals", count: pendingCount },
    // Blue while a request has not been marked as contacted (Quote requests page).
    { href: "/quotes", label: "Quote requests", count: quoteCount, tone: "new" },
    { href: "/shops", label: "Customers" },
    { href: "/licenses", label: "Licenses" },
    // Red when a till crashed or staff reported a problem in the last day (server/crashes.ts).
    { href: "/crashes", label: "Crashes", count: crashCount, tone: "alert", groupStart: true },
    { href: "/pricing", label: "Pricing", groupStart: true },
    { href: "/contact", label: "Contact details" },
    { href: "/admins", label: "Administrators" },
    { href: "/audit", label: "Audit log" },
    { href: "/releases", label: "Releases" },
  ];

  return (
    <nav className="vbg-custom-sidebar-nav" aria-label="Sections">
      <ul>
        {items.map((item) => {
          // Approvals lives at the root, so it has to match exactly or every
          // page would light it up. The rest own their whole subtree, which
          // keeps Licenses current while a license detail page is open.
          const current =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <li key={item.href} className={item.groupStart ? "vbg-custom-sidebar-group-start" : undefined}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
              >
                <span>{item.label}</span>
                {item.count ? (
                  <span className={item.tone ? `vbg-custom-sidebar-${item.tone}` : "vbg-custom-sidebar-count"}>
                    {item.count}
                    <span className="vbg-visually-hidden">
                      {item.tone === "alert" ? " in the last day" : item.tone === "new" ? " not contacted yet" : " waiting"}
                    </span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
