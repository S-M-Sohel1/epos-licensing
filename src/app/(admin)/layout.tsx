import Link from "next/link";
import { redirect } from "next/navigation";

import { SidebarNav } from "~/app/_components/sidebar-nav";
import { auth, signOut } from "~/server/auth";
import { countRecentCrashes } from "~/server/crashes";
import { db } from "~/server/db";

/**
 * The panel shell: a persistent sidebar beside a scrolling content column.
 *
 * The brand foundation's own shell assumes a single-column report and carries
 * the Vercel wordmark, which belongs on a Vercel-authored surface. This is a
 * vendor's internal tool with several pages, so the topology is page-owned and
 * the identity slot names the product. Everything inside the content column
 * still runs on the foundation's shell, grid, type roles and restraint.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.email) redirect("/signin");

  const [pending, newQuotes, recentCrashes] = await Promise.all([
    db.device.count({ where: { status: "pending" } }),
    // Not rung back yet: what the Quote requests page lists first.
    db.quoteRequest.count({ where: { contactedAt: null } }),
    countRecentCrashes(),
  ]);

  return (
    <div className="vbg-custom-app">
      <a className="vbg-skip-link" href="#main">
        Skip to content
      </a>

      <aside className="vbg-custom-sidebar">
        <Link href="/" className="vbg-custom-brand">
          <span className="vbg-custom-brand-name">EPos 365</span>
          <span className="vbg-custom-brand-role">Licensing</span>
        </Link>

        <SidebarNav pendingCount={pending} quoteCount={newQuotes} crashCount={recentCrashes} />

        <div className="vbg-custom-sidebar-user">
          <span className="vbg-custom-sidebar-user-email">
            {session.user.email}
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <button type="submit" className="vbg-custom-link-action">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="vbg-custom-main">
        <div className="vbg-shell">
          <main id="main">{children}</main>

          <footer className="vbg-footer">
            <span className="vbg-meta">EPos 365</span>
            <span className="vbg-meta">
              Internal. Licensing records and customer contact details.
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}
