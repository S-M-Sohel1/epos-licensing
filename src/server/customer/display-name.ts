/**
 * What a customer (a shop owner's account) is called in the admin panel.
 *
 * An account made before registration asked for a name has none, and a list of rows all
 * reading "(unnamed)" tells an admin nothing. The email identifies the account just as well,
 * so it stands in; "(unnamed)" is left for an account with neither.
 */
export function customerDisplayName(customer: { name: string | null; email: string | null }): string {
  const name = customer.name?.trim();
  if (name) return name;
  const email = customer.email?.trim();
  if (email) return email;
  return "(unnamed)";
}

/** A typed name, or null when the box was left empty: never an empty string in the database. */
export function nameOrNull(typed: string | undefined): string | null {
  const name = typed?.trim();
  if (name) return name;
  return null;
}
