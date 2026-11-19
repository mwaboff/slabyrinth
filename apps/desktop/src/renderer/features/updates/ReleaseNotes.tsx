/**
 * Untrusted release notes as an allow-listed Markdown subset (shared/releaseNotes.ts parses; this only maps the
 * tree to fixed elements). Every string from the notes becomes a React text node; nothing from them reaches an
 * attribute (class names are the static ones below, list keys are indexes). No links, images or HTML exist here.
 */
import { Fragment, useMemo, type ReactNode } from "react";
import { parseReleaseNotes, type Inline, type NoteBlock, type NoteList } from "../../../shared/releaseNotes";

export const TRUNCATED_TEXT = "…see the full notes on the release page (Download).";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return (
          <code key={i} className="upd-md__code">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.c)}</em>;
    }
  });
}

function renderList(list: NoteList, nested: boolean): ReactNode {
  const cls = nested ? "upd-md__list upd-md__list--sub" : "upd-md__list";
  const items = list.items.map((it, i) => (
    <li key={i}>
      {renderInline(it.c)}
      {it.sub !== undefined && renderList(it.sub, true)}
    </li>
  ));
  return list.ordered ? <ol className={cls}>{items}</ol> : <ul className={cls}>{items}</ul>;
}

/** # and ## are the release's own titles; ### is a Keep a Changelog section ("Added", "Fixed", …). */
const HEADING_CLASS = {
  1: "upd-md__h upd-md__h--1",
  2: "upd-md__h upd-md__h--2",
  3: "upd-md__h upd-md__h--3",
  4: "upd-md__h upd-md__h--4",
} as const;

function renderBlock(b: NoteBlock, i: number): ReactNode {
  switch (b.t) {
    case "heading": {
      // Popover-sized headings (h3–h6 under the dialog's own title), never page-sized.
      const content = renderInline(b.c);
      const cls = HEADING_CLASS[b.level];
      if (b.level === 1)
        return (
          <h3 key={i} className={cls}>
            {content}
          </h3>
        );
      if (b.level === 2)
        return (
          <h4 key={i} className={cls}>
            {content}
          </h4>
        );
      if (b.level === 3)
        return (
          <h5 key={i} className={cls}>
            {content}
          </h5>
        );
      return (
        <h6 key={i} className={cls}>
          {content}
        </h6>
      );
    }
    case "para":
      return (
        <p key={i} className="upd-md__p">
          {renderInline(b.c)}
        </p>
      );
    case "list":
      return <Fragment key={i}>{renderList(b.list, false)}</Fragment>;
  }
}

export function ReleaseNotes({ notes }: { notes: string }) {
  const doc = useMemo(() => parseReleaseNotes(notes), [notes]);
  return (
    <div className="upd__notes upd-md" tabIndex={0} aria-label="What's new">
      {doc.blocks.map(renderBlock)}
      {doc.truncated && <p className="upd-md__more">{TRUNCATED_TEXT}</p>}
    </div>
  );
}
