import { Fragment, type ReactNode } from "react";
import type { PublicUser } from "@nebula/shared";

export interface MarkdownDeps {
  /** Mentioned users resolved for this message (from `message.mentions`). */
  mentions?: PublicUser[];
  /** channelId -> display name, for <#id> refs. */
  channels?: Map<string, string>;
  /** roleId -> role, for <@&id> refs. */
  roles?: Map<string, { name: string; color: number }>;
  /** Rendered when an @mention points at the current user. */
  selfId?: string | null;
}

const TOKEN =
  /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*]+\*|_[^_]+_|<@!?\d+>|<@&\d+>|<#\d+>|@everyone|@here|https?:\/\/[^\s]+)/g;

function Mention({
  children,
  kind,
  self,
  color,
}: {
  children: ReactNode;
  kind: "user" | "role" | "channel";
  self?: boolean;
  color?: string;
}) {
  if (kind === "channel") {
    return <span className="rounded bg-nebula-800 px-1 font-medium text-slate-200">#{children}</span>;
  }
  if (kind === "role") {
    return (
      <span
        className="rounded px-1 font-medium"
        style={{ color: color ?? "#c7d2fe", backgroundColor: `${color ?? "#6366f1"}22` }}
      >
        @{children}
      </span>
    );
  }
  return (
    <span
      className={`rounded px-1 font-medium ${self ? "bg-nebula-accent/25 text-white" : "bg-nebula-accent/15 text-nebula-accent"}`}
    >
      @{children}
    </span>
  );
}

function renderInline(text: string, deps: MarkdownDeps, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  const mentionMap = new Map((deps.mentions ?? []).map((u) => [u.id, u]));

  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    last = at + token.length;
    const key = `${keyBase}-${index++}`;

    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), deps, key)}</strong>);
    } else if (token.startsWith("__") && token.endsWith("__")) {
      nodes.push(<u key={key}>{renderInline(token.slice(2, -2), deps, key)}</u>);
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      nodes.push(<s key={key}>{renderInline(token.slice(2, -2), deps, key)}</s>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-nebula-950/80 px-1 py-0.5 font-mono text-[0.85em] text-nebula-accent2">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), deps, key)}</em>);
    } else if (token.startsWith("_") && token.endsWith("_") && token.length > 2) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), deps, key)}</em>);
    } else if (token === "@everyone" || token === "@here") {
      nodes.push(
        <span key={key} className="rounded bg-nebula-warn/20 px-1 font-medium text-nebula-warn">
          {token}
        </span>,
      );
    } else if (token.startsWith("<@&")) {
      const roleId = token.slice(3, -1);
      const role = deps.roles?.get(roleId);
      const color = role ? `#${(role.color ?? 0).toString(16).padStart(6, "0")}` : undefined;
      nodes.push(
        <Mention key={key} kind="role" color={role && role.color ? color : undefined}>
          {role?.name ?? "role"}
        </Mention>,
      );
    } else if (token.startsWith("<#")) {
      const channelId = token.slice(2, -1);
      nodes.push(
        <Mention key={key} kind="channel">
          {deps.channels?.get(channelId) ?? "channel"}
        </Mention>,
      );
    } else if (token.startsWith("<@")) {
      const userId = token.replace(/^<@!?/, "").slice(0, -1);
      const user = mentionMap.get(userId);
      nodes.push(
        <Mention key={key} kind="user" self={userId === deps.selfId}>
          {user?.displayName || user?.username || "user"}
        </Mention>,
      );
    } else if (token.startsWith("http")) {
      nodes.push(
        <a
          key={key}
          href={token}
          target="_blank"
          rel="noreferrer noopener"
          className="text-nebula-accent hover:underline"
        >
          {token}
        </a>,
      );
    } else {
      nodes.push(token);
    }
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render message content: fenced code blocks, inline formatting, mentions, links. */
export function renderMarkdown(content: string, deps: MarkdownDeps = {}): ReactNode {
  if (!content) return null;
  const blocks = content.split(/```/);
  return (
    <>
      {blocks.map((block, i) => {
        if (i % 2 === 1) {
          // Fenced code block; strip an optional leading language hint.
          const newline = block.indexOf("\n");
          const hasLang = newline > 0 && /^[a-zA-Z0-9+#-]+$/.test(block.slice(0, newline).trim());
          const body = hasLang ? block.slice(newline + 1) : block;
          return (
            <pre key={`code-${i}`} className="my-1 overflow-x-auto rounded-md border border-nebula-800 bg-nebula-950/80 p-3">
              <code className="font-mono text-xs text-slate-200">{body.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        const lines = block.split("\n");
        return (
          <Fragment key={`text-${i}`}>
            {lines.map((line, li) => (
              <Fragment key={`line-${i}-${li}`}>
                {renderInline(line, deps, `l${i}-${li}`)}
                {li < lines.length - 1 && <br />}
              </Fragment>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}
