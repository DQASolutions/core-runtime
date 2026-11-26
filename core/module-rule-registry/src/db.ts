// Minimal structural DB port. node-postgres `Pool`/`PoolClient` satisfy this, so
// the registry stays free of a hard `pg` dependency and is unit-testable with a fake.

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>
}
