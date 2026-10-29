import { Button } from '@/components/ui/button';
import { t, useLanguage } from '@/lib/i18n';
"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import * as React from "react";
import { cn } from "@/lib/utils";

type ConfirmTone = "default" | "danger";
type ConfirmSize = "default" | "wide";

export interface ConfirmOptions {
  readonly title: string;
  readonly body?: React.ReactNode;
  readonly confirmText?: string;
  readonly cancelText?: string;
  readonly tone?: ConfirmTone;
  readonly size?: ConfirmSize;
  readonly returnFocus?: React.RefObject<HTMLElement | null>;
}

export interface ConfirmCheckedOptions extends ConfirmOptions {
  readonly checkboxLabel: string;
  readonly checkboxDefaultChecked?: boolean;
  readonly secondaryCheckboxLabel?: string;
  readonly secondaryCheckboxWarning?: string;
  readonly secondaryConfirmText?: string;
}

export interface ConfirmCheckedResult {
  readonly confirmed: boolean;
  readonly checked: boolean;
  readonly secondaryChecked?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
type ConfirmCheckedFn = (opts: ConfirmCheckedOptions) => Promise<ConfirmCheckedResult>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);
const ConfirmCheckedContext = React.createContext<ConfirmCheckedFn | null>(null);

export function useConfirm(): ConfirmFn {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmDialogProvider");
  return confirm;
}

export function useConfirmChecked(): ConfirmCheckedFn {
  const confirm = React.useContext(ConfirmCheckedContext);
  if (!confirm) throw new Error("useConfirmChecked must be used within a ConfirmDialogProvider");
  return confirm;
}

interface DialogState extends ConfirmOptions {
  readonly open: boolean;
  readonly checkboxLabel?: string;
  readonly secondaryCheckboxLabel?: string;
  readonly secondaryCheckboxWarning?: string;
  readonly secondaryConfirmText?: string;
}

const CLOSED: DialogState = { open: false, title: "" };

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  useLanguage();
  const [state, setState] = React.useState<DialogState>(CLOSED);
  const [checked, setChecked] = React.useState(false);
  const [secondaryChecked, setSecondaryChecked] = React.useState(false);
  const resolverRef = React.useRef<((value: ConfirmCheckedResult) => void) | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const settle = React.useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState(prev => ({ ...prev, open: false }));
    resolve?.({ confirmed: value, checked,
      ...(state.secondaryCheckboxLabel ? { secondaryChecked: checked && secondaryChecked } : {}) });
  }, [checked, secondaryChecked, state.secondaryCheckboxLabel]);

  const request = React.useCallback<ConfirmCheckedFn>(opts => {
    // Resolve any dialog still pending before opening a new one.
    resolverRef.current?.({ confirmed: false, checked: false });
    return new Promise<ConfirmCheckedResult>(resolve => {
      resolverRef.current = resolve;
      setChecked(opts.checkboxDefaultChecked === true);
      setSecondaryChecked(false);
      setState({ ...opts, open: true });
    });
  }, []);
  const confirmChecked = request;
  const confirm = React.useCallback<ConfirmFn>(async opts => (
    await request({ ...opts, checkboxLabel: "" })
  ).confirmed, [request]);

  const secondarySelected = checked && secondaryChecked && !!state.secondaryCheckboxLabel;
  const tone = secondarySelected ? "danger" : state.tone ?? "default";

  return (
    <ConfirmContext.Provider value={confirm}>
      <ConfirmCheckedContext.Provider value={confirmChecked}>
        {children}
      <AlertDialog.Root
        open={state.open}
        onOpenChange={open => {
          if (!open) {
            settle(false);
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop
            className={cn(
              "fixed inset-0 z-(--z-dialog) bg-black/32 backdrop-blur-[2px] transition-opacity duration-180",
              "data-starting-style:opacity-0 data-ending-style:opacity-0 dark:bg-black/55",
            )}
          />
          <AlertDialog.Popup
            initialFocus={cancelRef}
            finalFocus={state.returnFocus}
            className={cn(
              "fixed top-1/2 left-1/2 z-(--z-dialog) w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
              state.size === "wide" ? "max-w-[440px]" : "max-w-90",
              "rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg/10",
              "transition-[opacity,transform] duration-180 [transition-timing-function:cubic-bezier(.22,1,.36,1)]",
              "data-starting-style:scale-[.97] data-starting-style:opacity-0",
              "data-ending-style:scale-[.97] data-ending-style:opacity-0",
            )}
          >
            <AlertDialog.Title className="text-[15px] font-semibold tracking-[-.01em]">
              {state.title}
            </AlertDialog.Title>
            {state.body != null && (
              <AlertDialog.Description className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                {state.body}
              </AlertDialog.Description>
            )}
            {state.checkboxLabel && (
              <label className="mt-4 grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-[13px] text-popover-foreground">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={event => {
                    setChecked(event.currentTarget.checked);
                    if (!event.currentTarget.checked) setSecondaryChecked(false);
                  }}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                />
                <span>{state.checkboxLabel}</span>
              </label>
            )}
            {checked && state.secondaryCheckboxLabel && (
              <div className="mt-3">
                <label className="grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-[13px] text-popover-foreground">
                  <input type="checkbox" checked={secondaryChecked}
                    onChange={event => setSecondaryChecked(event.currentTarget.checked)}
                    className="mt-0.5 size-4 accent-[var(--accent)]" />
                  <span>{state.secondaryCheckboxLabel}</span>
                </label>
                {secondarySelected && state.secondaryCheckboxWarning && (
                  <p className="mt-2 ml-6 text-[12px] leading-relaxed text-destructive">
                    {state.secondaryCheckboxWarning}
                  </p>
                )}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline"
                ref={cancelRef}
                type="button"
                onClick={() => settle(false)}
              >
                {state.cancelText ?? t("取消")}
              </Button>
              <Button
                type="button"
                variant={tone === "danger" ? "danger" : "default"}
                onClick={() => settle(true)}
              >
                {secondarySelected ? state.secondaryConfirmText ?? state.confirmText ?? t("确定")
                  : state.confirmText ?? t("确定")}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      </ConfirmCheckedContext.Provider>
    </ConfirmContext.Provider>
  );
}
