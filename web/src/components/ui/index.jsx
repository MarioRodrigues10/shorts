// Small, consistent component kit (shadcn-style) on top of Radix primitives.
import * as RTooltip from "@radix-ui/react-tooltip";
import * as RSlider from "@radix-ui/react-slider";
import * as RSwitch from "@radix-ui/react-switch";
import * as RToggle from "@radix-ui/react-toggle-group";
import * as RDialog from "@radix-ui/react-dialog";
import * as RMenu from "@radix-ui/react-dropdown-menu";
import * as RPopover from "@radix-ui/react-popover";
import { forwardRef } from "react";
import { CaretDown, ArrowCounterClockwise } from "@phosphor-icons/react";
import { cn } from "../../lib/hooks.js";

// ------------------------------------------------------------------ Button
const VARIANTS = {
  primary: "bg-accent text-white hover:bg-accent-hover shadow-[0_1px_0_rgb(255_255_255/0.15)_inset] font-semibold",
  secondary: "bg-surface-3 text-fg hover:bg-surface-4 border border-line",
  ghost: "text-muted hover:text-fg hover:bg-surface-3",
  danger: "text-danger hover:bg-danger/10",
  soft: "bg-accent-soft text-accent-ink hover:bg-accent/20",
};
const SIZES = {
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-2 rounded-lg",
  lg: "h-10 px-4 text-sm gap-2 rounded-lg",
  icon: "h-8 w-8 rounded-lg justify-center",
  "icon-sm": "h-7 w-7 rounded-md justify-center",
};
export const Button = forwardRef(function Button({ variant = "secondary", size = "md", className, active, ...p }, ref) {
  return (
    <button ref={ref} {...p}
      className={cn("inline-flex items-center whitespace-nowrap transition-colors disabled:opacity-40 disabled:pointer-events-none select-none cursor-pointer",
        VARIANTS[variant], SIZES[size], active && "!text-accent !bg-accent-soft", className)} />
  );
});

// ------------------------------------------------------------------ Tooltip
export function TipProvider({ children }) {
  return <RTooltip.Provider delayDuration={350} skipDelayDuration={150}>{children}</RTooltip.Provider>;
}
export function Tip({ label, kbd, side = "top", children }) {
  if (!label) return children;
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6}
          className="z-[100] flex items-center gap-2 rounded-md bg-tip px-2 py-1 text-xs text-white shadow-md">
          {label}{kbd && <Kbd>{kbd}</Kbd>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
export function Kbd({ children }) {
  return <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 font-mono text-[10px] leading-4 text-muted [.bg-tip_&]:border-white/25 [.bg-tip_&]:bg-white/10 [.bg-tip_&]:text-white/80">{children}</kbd>;
}

// Icon button with tooltip
export function IconBtn({ icon: I, label, kbd, size = "icon", variant = "ghost", iconSize = 16, side, ...p }) {
  return (
    <Tip label={label} kbd={kbd} side={side}>
      <Button variant={variant} size={size} aria-label={label} {...p}><I size={iconSize} /></Button>
    </Tip>
  );
}

// ------------------------------------------------------------------ Fields
export function Field({ label, hint, children, onReset, className }) {
  return (
    <div className={cn("group/f py-1.5", className)}>
      {label && (
        <div className="mb-1.5 flex items-center gap-1 text-xs text-muted">
          <span className="font-medium">{label}</span>
          {onReset && (
            <button onClick={onReset} title="Reset" className="opacity-0 group-hover/f:opacity-100 text-subtle hover:text-fg transition-opacity">
              <ArrowCounterClockwise size={11} />
            </button>
          )}
          <span className="flex-1" />
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

export function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, format, resetTo }) {
  const v = Number.isFinite(value) ? value : (resetTo ?? min);
  const shown = format ? format(v) : (Number.isInteger(step) ? v : v.toFixed(2));
  return (
    <Field label={label} onReset={resetTo !== undefined && v !== resetTo ? () => onChange(resetTo) : undefined}
      hint={<span className="font-mono text-[11px] text-fg/80 tabular-nums">{shown}</span>}>
      <RSlider.Root className="relative flex h-4 w-full touch-none items-center select-none" value={[v]} min={min} max={max} step={step}
        onValueChange={([x]) => onChange(x)} onDoubleClick={() => resetTo !== undefined && onChange(resetTo)}>
        <RSlider.Track className="relative h-1 grow rounded-full bg-surface-4">
          <RSlider.Range className="absolute h-full rounded-full bg-accent" />
        </RSlider.Track>
        <RSlider.Thumb className="block h-3.5 w-3.5 rounded-full border border-line-strong bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] outline-none ring-accent/40 focus-visible:ring-4 hover:scale-110 transition-transform" />
      </RSlider.Root>
    </Field>
  );
}

export function Switch({ label, checked, onChange, hint }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-2">
      <span className="flex-1">
        <span className="block text-[13px]">{label}</span>
        {hint && <span className="block text-xs text-subtle mt-0.5 leading-snug">{hint}</span>}
      </span>
      <RSwitch.Root checked={!!checked} onCheckedChange={onChange}
        className="relative h-5 w-9 shrink-0 rounded-full bg-surface-4 transition-colors data-[state=checked]:bg-accent cursor-pointer">
        <RSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-transform data-[state=checked]:translate-x-[18px]" />
      </RSwitch.Root>
    </label>
  );
}

export function Segmented({ value, onChange, options, label, size = "md" }) {
  return (
    <Field label={label}>
      <RToggle.Root type="single" value={String(value)} onValueChange={(v) => v !== "" && onChange(options.find((o) => String(o[0]) === v)[0])}
        className="flex w-full rounded-lg bg-surface-2 p-0.5 border border-line">
        {options.map(([v, l, Icon]) => (
          <RToggle.Item key={String(v)} value={String(v)}
            className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-md text-muted transition-colors hover:text-fg cursor-pointer",
              "data-[state=on]:bg-surface-4 data-[state=on]:text-fg data-[state=on]:shadow-sm", size === "sm" ? "h-6 text-[11px]" : "h-7 text-xs")}>
            {Icon && <Icon size={13} />}{l}
          </RToggle.Item>
        ))}
      </RToggle.Root>
    </Field>
  );
}

export function Select({ label, value, onChange, options }) {
  return (
    <Field label={label}>
      <div className="relative">
        <select value={String(value)} onChange={(e) => { const o = options.find((x) => String(x[0]) === e.target.value); onChange(o ? o[0] : e.target.value); }}
          className="h-8 w-full appearance-none rounded-lg border border-line bg-surface-2 pl-2.5 pr-8 text-[13px] text-fg outline-none hover:border-line-strong focus:border-accent cursor-pointer">
          {options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
        </select>
        <CaretDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle" />
      </div>
    </Field>
  );
}

const SWATCHES = ["#ffffff", "#000000", "#facc15", "#ffe500", "#22c55e", "#4ade80", "#ef4444", "#f97316", "#7c3aed", "#1e9baa", "#06b6d4", "#ec4899"];
export function ColorField({ label, value, onChange, allowNone }) {
  return (
    <Field label={label}>
      <div className="flex flex-wrap items-center gap-1.5">
        {allowNone && (
          <button onClick={() => onChange("")} title="None"
            className={cn("h-6 w-6 rounded-md border border-line-strong bg-[linear-gradient(135deg,transparent_45%,#f43f5e_45%,#f43f5e_55%,transparent_55%)]", !value && "ring-2 ring-accent ring-offset-1 ring-offset-surface")} />
        )}
        {SWATCHES.map((c) => (
          <button key={c} onClick={() => onChange(c)} title={c}
            className={cn("h-6 w-6 rounded-md border border-line-strong transition-colors hover:border-fg/40", value?.toLowerCase() === c && "ring-2 ring-accent ring-offset-1 ring-offset-surface")}
            style={{ background: c }} />
        ))}
        <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-md border border-line-strong bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]" title="Custom color">
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(value || "") ? value : "#ffffff"} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
      </div>
    </Field>
  );
}

export function Section({ title, children, action, className }) {
  return (
    <section className={cn("border-b border-line px-4 py-3 last:border-0", className)}>
      {title && (
        <div className="mb-1 flex items-center">
          <h4 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</h4>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ Dialog
export function Dialog({ open, onOpenChange, title, description, children, className }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RDialog.Content className={cn("fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-surface p-6 shadow-xl outline-none", className)}>
          {title && <RDialog.Title className="text-base font-semibold">{title}</RDialog.Title>}
          {description && <RDialog.Description className="mt-1 text-[13px] text-muted">{description}</RDialog.Description>}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ------------------------------------------------------------------ Menu
export function Menu({ trigger, items, align = "end" }) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content align={align} sideOffset={6} className="z-[90] min-w-[200px] rounded-lg border border-line-strong bg-surface-2 p-1 shadow-lg">
          {items.map((it, i) => it === "-" ? <RMenu.Separator key={i} className="my-1 h-px bg-line" /> : (
            <RMenu.Item key={i} disabled={it.disabled} onSelect={it.onSelect}
              className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-4 data-[disabled]:opacity-40", it.danger && "text-danger")}>
              {it.icon && <it.icon size={14} className="text-muted" />}<span className="flex-1">{it.label}</span>{it.kbd && <Kbd>{it.kbd}</Kbd>}
            </RMenu.Item>
          ))}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

export function Popover({ trigger, children, side = "bottom", align = "center", open, onOpenChange }) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content side={side} align={align} sideOffset={8} className="z-[90] rounded-lg border border-line-strong bg-surface-2 p-3 shadow-lg outline-none">
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export function Empty({ icon: I, art, title, children }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {art ? <img src={art} alt="" draggable={false} className="mb-2 h-32 w-auto" /> : I && <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-surface-3 text-muted"><I size={20} /></div>}
      <div className="text-[13px] font-medium">{title}</div>
      {children && <div className="mt-1.5 text-xs text-subtle leading-relaxed">{children}</div>}
    </div>
  );
}

export function Progress({ value, className }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-surface-4", className)}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

// Drag handle between panels. dir "v" (left/right) or "h" (up/down); invert for panels on the right/bottom.
export function Resizer({ dir = "v", size, onSize, invert = false }) {
  const start = (e) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add("active");
    el.setPointerCapture(e.pointerId);
    const p0 = dir === "v" ? e.clientX : e.clientY, s0 = size;
    const move = (ev) => {
      const d = (dir === "v" ? ev.clientX : ev.clientY) - p0;
      onSize(s0 + (invert ? -d : d));
    };
    const up = () => { el.classList.remove("active"); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return <div className={`resizer ${dir}`} onPointerDown={start} onDoubleClick={() => onSize(null)} title="Drag to resize (double-click to reset)" />;
}
