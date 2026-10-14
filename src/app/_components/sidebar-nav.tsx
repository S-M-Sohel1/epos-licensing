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
export function SidebarNav({ pendingCount, crashCount }: { pendingCount: number; crashCount: number }) {
  const pathname = usePathname();

  // In order of how often the operator acts on each, in three groups with a rule between them:
  // what is waiting on someone, support, and set-up that rarely changes. Releases is last: the
  // developer publishes till versions there, not the operator.
  const items: { href: string; label: string; count?: number; alert?: boolean; groupStart?: boolean }[] = [
    { href: "/", label: "Approvals", count: pendingCount },
    { href: "/quotes", label: "Quote requests" },
    { href: "/shops", label: "Customers" },
    { href: "/licenses", label: "Licenses" },
    // Red when a till crashed or staff reported a problem in the last day (server/crashes.ts).
    { href: "/crashes", label: "Crashes", count: crashCount, alert: true, groupStart: true },
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
                  <span className={item.alert ? "vbg-custom-sidebar-alert" : "vbg-custom-sidebar-count"}>
                    {item.count}
                    <span className="vbg-visually-hidden">{item.alert ? " in the last day" : " waiting"}</span>
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
