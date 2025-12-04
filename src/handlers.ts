export type MergeRouters<R extends readonly object[]> = R extends readonly [
  infer Head,
  ...infer Tail
]
  ? Head & (Tail extends readonly object[] ? MergeRouters<Tail> : unknown)
  : {};

export const registerHandlers = <R extends readonly object[]>(
  ...routers: R
): MergeRouters<R> => Object.assign({}, ...routers) as MergeRouters<R>;
