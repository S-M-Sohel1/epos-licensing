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
export function SidebarNav({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();

  const items = [
    { href: "/", label: "Approvals", count: pendingCount },
    { href: "/licenses", label: "Licenses" },
    { href: "/shops", label: "Customers" },
    { href: "/quotes", label: "Quote requests" },
    { href: "/releases", label: "Releases" },
    { href: "/pricing", label: "Pricing" },
    { href: "/audit", label: "Audit log" },
    { href: "/admins", label: "Administrators" },
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
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
              >
                <span>{item.label}</span>
                {item.count ? (
                  <span className="vbg-custom-sidebar-count">
                    {item.count}
                    <span className="vbg-visually-hidden"> waiting</span>
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
