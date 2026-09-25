export type StudioTenantInfo = Readonly<{ id: string; name: string }>;

export function shortTenantId(id: string): string {
  if (id.length <= 11) return id;
  return `${id.slice(0, 3)}…${id.slice(-8)}`;
}
