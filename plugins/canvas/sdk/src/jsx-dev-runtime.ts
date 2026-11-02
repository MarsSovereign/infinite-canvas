// automatic JSX 的 dev 变体(编译器在 dev 模式会引用 jsxDEV)。转发到同一套 createElement。

import type * as React from "react";

import { Fragment, jsx, jsxs } from "./jsx-runtime";

export { Fragment };
export type { JSX } from "./jsx-runtime";

// jsxDEV 的第 4 个参数标记 children 是否为静态多子节点,与 jsxs 的语义相同。
export function jsxDEV(type: unknown, props: Record<string, unknown> | null, key?: unknown, isStaticChildren?: boolean): React.ReactElement {
    return isStaticChildren ? jsxs(type, props, key) : jsx(type, props, key);
}
