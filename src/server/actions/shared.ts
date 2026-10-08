import { redirect } from "next/navigation";

import { auth } from "~/server/auth";

/**
 * Every Server Action starts here. The panel has one operator today, so this is
 * an authentication check rather than an authorization one, but routing it
 * through a single function means adding a `role` column later touches one
 * place rather than every action.
 */
export async function requireAdmin(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;

  if (!email) redirect("/signin");

  return email;
}

/**
 * Sends the operator back to the page they acted on, carrying a one-line
 * outcome.
 *
 * Server-rendered feedback rather than client-side form state: the outcome
 * always reflects committed database state, which matters when the message is
 * "this license is already at its device limit" and the reason is a row someone
 * else just changed.
 */
/**
 * Reads a text field. `FormData.get` can also hand back a `File`, which would
 * stringify to "[object Object]" and be stored as if it were a real value.
 */
export function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export function redirectWithNotice(
  path: string,
  notice: string,
  tone: "error" | "success" = "error",
): never {
  const params = new URLSearchParams({ notice, tone });
  redirect(`${path}${path.includes("?") ? "&" : "?"}${params.toString()}`);
}
