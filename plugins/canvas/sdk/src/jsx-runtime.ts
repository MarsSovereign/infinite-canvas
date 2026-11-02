// automatic JSX 运行时:esbuild/tsc 的 `jsxImportSource` 指向本包时,
// TSX 会被编译成对本模块 jsx()/jsxs() 的调用。这里统一转发到宿主 React.createElement,
// 让插件写纯 TSX、无需手动 `const { React } = runtime`,同时 react 全程 external。

import type * as React from "react";

import { getReact } from "./runtime";

// Fragment 哨兵:渲染时才解析为宿主 React.Fragment,避免模块顶层触碰运行时。
export const Fragment = Symbol.for("infinite-canvas.jsx.fragment") as unknown as React.ExoticComponent<{ children?: React.ReactNode }>;

function createElement(type: unknown, props: Record<string, unknown> | null, key: unknown, isStaticChildren: boolean): React.ReactElement {
    const react = getReact();
    const resolvedType = type === Fragment ? react.Fragment : type;
    // automatic 运行时把 children 放在 props 里、key 单独传入;这里取出 children 作为 createElement 的参数传递。
    const { children, ...rest } = props ?? {};
    const config = key === undefined ? rest : { ...rest, key };
    if (children === undefined) return react.createElement(resolvedType as never, config as never);
    // jsxs 的 children 是写死的多个子节点,必须展开传入;整体作为数组传会被 React 当成动态列表,逐个要求 key。
    if (isStaticChildren && Array.isArray(children)) return react.createElement(resolvedType as never, config as never, ...(children as React.ReactNode[]));
    return react.createElement(resolvedType as never, config as never, children as React.ReactNode);
}

export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): React.ReactElement {
    return createElement(type, props, key, false);
}

// jsxs 用于静态多子节点(编译器保证这些子节点固定,不需要 key)。
export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): React.ReactElement {
    return createElement(type, props, key, true);
}

// 让 `jsxImportSource` 指向本包的编译器能从这里取到 JSX 内建标签类型(复用 @types/react)。
export namespace JSX {
    export type Element = React.JSX.Element;
    export type ElementType = React.JSX.ElementType;
    export type ElementClass = React.JSX.ElementClass;
    export type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
    export type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
    export type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
    export type IntrinsicAttributes = React.JSX.IntrinsicAttributes;
    export type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>;
    export type IntrinsicElements = React.JSX.IntrinsicElements;
}
