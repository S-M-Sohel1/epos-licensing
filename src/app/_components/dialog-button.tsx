"use client";

import { useId, useRef, type ReactNode } from "react";

/**
 * A button that opens a small dialog over the page: for an action used rarely enough that its
 * form should not sit open on the page, and consequential enough to want a sentence and a
 * second click. The native <dialog>, so focus is held inside it and Escape closes it.
 *
 * The form inside posts a Server Action that redirects, which is what closes the dialog on
 * success; "Cancel" is rendered here.
 */
export function DialogButton({
  label,
  title,
  quiet = false,
  children,
}: {
  label: string;
  title: string;
  /** A text-weight trigger, for the second and third action in a row. */
  quiet?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  return (
    <>
      <button
        type="button"
        className={quiet ? "vbg-custom-link-action" : "vbg-button"}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <dialog ref={dialog} className="vbg-custom-dialog" aria-labelledby={titleId}>
        <h3 id={titleId} className="vbg-heading-24">
          {title}
        </h3>
        {children}
        <button type="button" className="vbg-custom-link-action" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
      </dialog>
    </>
  );
}
