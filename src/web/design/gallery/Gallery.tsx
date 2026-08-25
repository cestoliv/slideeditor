import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  ContextMenu,
  Dialog,
  DropdownMenu,
  Field,
  Icon,
  IconButton,
  Inline,
  Input,
  MenuRow,
  MenuSeparator,
  Popover,
  Select,
  Slider,
  Stack,
  Switch,
  Tabs,
  Textarea,
  Toast,
  ToastProvider,
  Tooltip,
  iconNames,
  useToast,
} from "../index.js";
import type { BadgeTone, ButtonVariant, IconButtonVariant, SpaceStep } from "../index.js";
import styles from "./Gallery.module.css";

/*
 * The page a human opens to check the design system. It renders every primitive
 * in every documented state, the token scales as swatches, and light and dark
 * beside each other, because a token layer that is only ever seen one theme at a
 * time is a token layer whose dark values nobody has looked at.
 *
 * It is development only. Gate the route on import.meta.env.DEV and load it with
 * React.lazy, so the bundler drops this file and everything it pulls in.
 */

const paletteTokens = [
  "--color-ink",
  "--color-muted",
  "--color-paper",
  "--color-panel",
  "--color-line",
  "--color-line-soft",
  "--color-white",
  "--color-accent",
  "--color-accent-warm",
  "--color-danger",
  "--color-danger-line",
  "--color-on-accent",
  "--surface-danger",
];

const surfaceTokens = [
  "--surface-grid",
  "--surface-header",
  "--surface-rail",
  "--surface-quiet",
  "--surface-icon",
  "--surface-card",
  "--surface-hover",
  "--surface-menu-hover",
  "--surface-workspace-center",
  "--surface-workspace-edge",
  "--surface-workspace-dot",
  "--surface-canvas-action",
  "--surface-canvas-action-line",
  "--surface-canvas-action-shadow",
  "--surface-empty",
  "--surface-backdrop",
];

const statusTokens = [
  "--color-status-draft",
  "--surface-status-draft",
  "--color-status-ready",
  "--surface-status-ready",
  "--color-status-published",
  "--surface-status-published",
];

const spaceTokens = [
  "--space-0",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-7",
  "--space-8",
];

const radiusTokens = [
  "--radius-sm",
  "--radius-control",
  "--radius-md",
  "--radius-card",
  "--radius-lg",
  "--radius-pill",
];

const typeTokens = [
  "--font-size-2xs",
  "--font-size-xs",
  "--font-size-sm",
  "--font-size-md",
  "--font-size-lg",
  "--font-size-xl",
  "--font-size-2xl",
];

const weightTokens = [
  "--font-weight-regular",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  "--font-weight-heavy",
];

const shadowTokens = [
  "--shadow-raised",
  "--shadow-pop",
  "--shadow-pop-hover",
  "--shadow-pop-soft",
  "--shadow-pop-modal",
  "--focus-ring",
];

const zTokens = [
  "--z-base",
  "--z-raised",
  "--z-overlay",
  "--z-menu",
  "--z-popover",
  "--z-tooltip",
  "--z-toast",
  "--z-drag",
];

const motionTokens = [
  "--duration-fast",
  "--duration-base",
  "--duration-slow",
  "--ease-out",
  "--motion-lift",
  "--motion-lift-strong",
];

const buttonVariants: readonly ButtonVariant[] = ["solid", "outline", "ghost", "danger"];
const iconButtonVariants: readonly IconButtonVariant[] = ["outline", "plain", "danger"];
const badgeTones: readonly BadgeTone[] = [
  "neutral",
  "accent",
  "warning",
  "success",
  "danger",
];

const sections = [
  ["tokens", "Tokens"],
  ["themes", "Light and dark"],
  ["buttons", "Buttons"],
  ["forms", "Forms"],
  ["content", "Content"],
  ["overlays", "Overlays"],
  ["menus", "Menus"],
  ["feedback", "Feedback"],
  ["icons", "Icons"],
] as const;

/*
 * The resolved value is read from the element itself rather than from :root, so
 * a swatch inside a pinned dark panel reports that panel's value.
 */
function Swatch({ token }: { token: string }) {
  const paint = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const node = paint.current;
    if (node === null) return;
    setValue(getComputedStyle(node).getPropertyValue(token).trim());
  }, [token]);

  return (
    <div className={styles.swatch}>
      <span className={styles.chip}>
        <span
          ref={paint}
          className={styles.chipPaint}
          style={{ background: `var(${token})` }}
        />
      </span>
      <span className={styles.swatchText}>
        <span className={styles.swatchName} title={token}>
          {token.replace("--", "")}
        </span>
        <span className={styles.swatchValue}>{value}</span>
      </span>
    </div>
  );
}

function Swatches({ tokens }: { tokens: readonly string[] }) {
  return (
    <div className={styles.swatches}>
      {tokens.map((token) => (
        <Swatch key={token} token={token} />
      ))}
    </div>
  );
}

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} id={id}>
      <h2 className={styles.sectionHead}>{title}</h2>
      {note === undefined ? null : <p className={styles.note}>{note}</p>}
      {children}
    </section>
  );
}

function Specimen({
  label,
  column = false,
  children,
}: {
  label: string;
  column?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.specimen}>
      <div className={styles.specimenLabel}>{label}</div>
      <div className={column ? styles.column : styles.specimenBody}>{children}</div>
    </div>
  );
}

/* Two panels, each pinning a theme, so neither of them follows the machine. */
function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div className={styles.themes}>
      <div className={styles.themePanel} data-theme="light">
        <p className={styles.themeName}>Light</p>
        {children}
      </div>
      <div className={styles.themePanel} data-theme="dark">
        <p className={styles.themeName}>Dark</p>
        {children}
      </div>
    </div>
  );
}

function TokenSection() {
  return (
    <Section
      id="tokens"
      title="Tokens"
      note="Every value a component is allowed to use. A component reads a token and never writes a literal, which is what keeps light, dark and reduced motion to one override block each."
    >
      <Specimen label="Palette" column>
        <Swatches tokens={paletteTokens} />
      </Specimen>
      <Specimen label="Surfaces" column>
        <Swatches tokens={surfaceTokens} />
      </Specimen>
      <Specimen label="Project status" column>
        <Swatches tokens={statusTokens} />
      </Specimen>
      <Specimen label="Spacing" column>
        {spaceTokens.map((token) => (
          <div className={styles.scaleRow} key={token}>
            <span className={styles.scaleName}>{token}</span>
            <span className={styles.scaleBar} style={{ width: `var(${token})` }} />
          </div>
        ))}
      </Specimen>
      <Specimen label="Radii">
        {radiusTokens.map((token) => (
          <span
            className={styles.radiusBox}
            key={token}
            style={{ borderRadius: `var(${token})` }}
          >
            {token.replace("--radius-", "")}
          </span>
        ))}
      </Specimen>
      <Specimen label="Type scale" column>
        {typeTokens.map((token) => (
          <div key={token} style={{ fontSize: `var(${token})` }}>
            {token.replace("--font-size-", "")} · Slides are now 9:16
          </div>
        ))}
      </Specimen>
      <Specimen label="Weights" column>
        {weightTokens.map((token) => (
          <div key={token} style={{ fontWeight: `var(${token})` }}>
            {token.replace("--font-weight-", "")} · Slide Studio
          </div>
        ))}
      </Specimen>
      <Specimen label="Elevation">
        {shadowTokens.map((token) => (
          <span
            className={styles.shadowBox}
            key={token}
            style={{ boxShadow: `var(${token})` }}
          >
            {token.replace("--shadow-", "").replace("--", "")}
          </span>
        ))}
      </Specimen>
      <Specimen label="Stacking" column>
        {zTokens.map((token) => (
          <div className={styles.scaleRow} key={token}>
            <span className={styles.scaleName}>{token}</span>
            <span className={styles.swatchValue}>
              <Rung token={token} />
            </span>
          </div>
        ))}
      </Specimen>
      <Specimen label="Motion" column>
        {motionTokens.map((token) => (
          <div className={styles.scaleRow} key={token}>
            <span className={styles.scaleName}>{token}</span>
            <span className={styles.swatchValue}>
              <Rung token={token} />
            </span>
          </div>
        ))}
      </Specimen>
    </Section>
  );
}

/* A token whose value is a number or a keyword rather than something paintable. */
function Rung({ token }: { token: string }) {
  const [value, setValue] = useState("");
  const probe = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = probe.current;
    if (node === null) return;
    setValue(getComputedStyle(node).getPropertyValue(token).trim());
  }, [token]);

  return <span ref={probe}>{value}</span>;
}

/* One compact sample of each primitive, rendered once per theme. */
function ThemeSampler() {
  return (
    <Stack gap={3}>
      <Inline gap={2} wrap>
        {buttonVariants.map((variant) => (
          <Button key={variant} variant={variant} size="sm">
            {variant}
          </Button>
        ))}
      </Inline>
      <Inline gap={2} wrap>
        {badgeTones.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </Inline>
      <Inline gap={2} wrap>
        {iconButtonVariants.map((variant) => (
          <IconButton
            key={variant}
            icon="crop"
            label={`Crop, ${variant}`}
            variant={variant}
          />
        ))}
        <Switch aria-label="Snap to grid" defaultChecked />
      </Inline>
      <Input aria-label="Sample input" defaultValue="Morning routine" />
      <Select
        aria-label="Sample select"
        items={[{ value: "9:16", label: "Vertical" }]}
        defaultValue="9:16"
      />
      <Slider aria-label="Sample slider" defaultValue={40} />
      <Card padding="sm">
        <Stack gap={1}>
          <strong>Card</strong>
          <span className={styles.swatchValue}>Panel on paper</span>
        </Stack>
      </Card>
      <Tabs.Root defaultValue="one">
        <Tabs.List aria-label="Sample tabs">
          <Tabs.Trigger value="one">Slide</Tabs.Trigger>
          <Tabs.Trigger value="two">Layers</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="one" />
        <Tabs.Content value="two" />
      </Tabs.Root>
      <Toast open duration={Infinity}>
        Slides are now 9:16
      </Toast>
    </Stack>
  );
}

function ButtonSection() {
  return (
    <Section
      id="buttons"
      title="Buttons"
      note="The pill, the 42px minimum height and the one pixel hover lift are the app's. Busy keeps the control focusable and drops the press, which disabled cannot do."
    >
      {buttonVariants.map((variant) => (
        <Specimen key={variant} label={variant}>
          <Button variant={variant}>Export</Button>
          <Button variant={variant} size="sm">
            Export
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <Button variant={variant} busy>
            Busy
          </Button>
          <Button variant={variant}>
            <Icon name="download" />
            With a glyph
          </Button>
        </Specimen>
      ))}
      <Specimen label="As a link">
        <Button asChild variant="ghost">
          <a href="#buttons">A real anchor</a>
        </Button>
      </Specimen>
      <Specimen label="Icon button">
        {iconButtonVariants.map((variant) => (
          <IconButton
            key={variant}
            icon="trash"
            label={`Remove, ${variant}`}
            variant={variant}
          />
        ))}
        <IconButton icon="trash" label="Remove, small" size="sm" />
        <IconButton icon="trash" label="Remove, disabled" disabled />
        {/* The other arm: an arbitrary child, for marks that ship as images
            rather than as line art. The label still carries the whole name. */}
        <IconButton label="Share by AirDrop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M12 3v10" />
            <path d="m8 7 4-4 4 4" />
            <circle cx="12" cy="18" r="3" />
          </svg>
        </IconButton>
        <Tooltip content="Bring to front">
          <IconButton icon="front" label="Bring to front" />
        </Tooltip>
      </Specimen>
    </Section>
  );
}

const ratioItems = [
  { value: "9:16", label: "Vertical" },
  { value: "1:1", label: "Square" },
  { value: "4:5", label: "Portrait" },
  { value: "16:9", label: "Landscape", disabled: true },
];

function FormSection() {
  const [opacity, setOpacity] = useState(60);

  return (
    <Section
      id="forms"
      title="Forms"
      note="Every control reads its id, its description and its error state from the Field around it, so a form wires three attributes once instead of on every input."
    >
      <Specimen label="Input">
        <Input aria-label="Plain" defaultValue="Morning routine" />
        <Input aria-label="Small" inputSize="sm" defaultValue="Small" />
        <Input aria-label="Invalid" invalid defaultValue="Not allowed" />
        <Input aria-label="Disabled" disabled defaultValue="Disabled" />
        <Input aria-label="Empty" placeholder="Placeholder" />
      </Specimen>
      <Specimen label="Textarea">
        <Textarea aria-label="Notes" defaultValue="A caption for the first slide." />
        <Textarea aria-label="Invalid notes" invalid defaultValue="Too long." />
      </Specimen>
      <Specimen label="Field">
        <div className={styles.field}>
          <Field label="Project name" hint="Shown on the home screen.">
            <Input />
          </Field>
        </div>
        <div className={styles.field}>
          <Field label="Project name" error="Name is required.">
            <Input />
          </Field>
        </div>
      </Specimen>
      <Specimen label="Select">
        <div className={styles.field}>
          <Field label="Ratio" hint="Vertical exports at 1080 by 1920.">
            <Select items={ratioItems} defaultValue="9:16" />
          </Field>
        </div>
        <div className={styles.field}>
          <Field label="Ratio" error="Pick a ratio before exporting.">
            <Select items={ratioItems} placeholder="Choose a ratio" />
          </Field>
        </div>
        <div className={styles.field}>
          <Select aria-label="Disabled ratio" items={ratioItems} disabled />
        </div>
      </Specimen>
      <Specimen label="Switch">
        <Switch aria-label="Off" />
        <Switch aria-label="On" defaultChecked />
        <Switch aria-label="Disabled" disabled />
        <Switch aria-label="Disabled and on" defaultChecked disabled />
        <div className={styles.field}>
          <Field label="Snap to grid" hint="Layers land on the 24px grid.">
            <Switch />
          </Field>
        </div>
      </Specimen>
      <Specimen label="Slider" column>
        <div className={styles.slider}>
          <Slider aria-label="Opacity" value={opacity} onValueChange={setOpacity} />
        </div>
        <span className={styles.swatchValue}>aria-valuenow is {opacity}</span>
        <div className={styles.slider}>
          <Slider aria-label="Disabled opacity" defaultValue={30} disabled />
        </div>
      </Specimen>
    </Section>
  );
}

function ContentSection() {
  const steps: readonly SpaceStep[] = [1, 3, 5];

  return (
    <Section
      id="content"
      title="Content"
      note="Card, Badge and the two layout primitives. Stack and Inline take a step on the spacing scale rather than a length, so a layout cannot ask for a gap the scale does not have."
    >
      <Specimen label="Card">
        <Card padding="sm">Small</Card>
        <Card>Medium, the default</Card>
        <Card padding="lg">Large</Card>
        <Card interactive>Interactive, lifts on hover</Card>
      </Specimen>
      <Specimen label="Badge">
        {badgeTones.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </Specimen>
      <Specimen label="Stack" column>
        {steps.map((gap) => (
          <div className={styles.stackDemo} key={gap}>
            <Stack gap={gap}>
              <Badge>gap {gap}</Badge>
              <Badge>second</Badge>
            </Stack>
          </div>
        ))}
      </Specimen>
      <Specimen label="Inline" column>
        {steps.map((gap) => (
          <div className={styles.stackDemo} key={gap}>
            <Inline gap={gap}>
              <Badge>gap {gap}</Badge>
              <Badge>second</Badge>
              <Button size="sm">Aligned</Button>
            </Inline>
          </div>
        ))}
      </Specimen>
    </Section>
  );
}

function OverlaySection() {
  return (
    <Section
      id="overlays"
      title="Overlays"
      note="All four are Radix underneath, so the focus trap, the Escape handler, the outside click and the return of focus to the trigger come from one implementation rather than five."
    >
      <Specimen label="Dialog">
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <Button>Rename project</Button>
          </Dialog.Trigger>
          <Dialog.Content>
            <Dialog.Title>Rename project</Dialog.Title>
            <Dialog.Description>
              The name shows on the home screen and nowhere else.
            </Dialog.Description>
            <Field label="Project name">
              <Input defaultValue="Morning routine" />
            </Field>
            <Dialog.Actions>
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Dialog.Close asChild>
                <Button variant="solid">Save</Button>
              </Dialog.Close>
            </Dialog.Actions>
          </Dialog.Content>
        </Dialog.Root>
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <Button variant="danger">Delete project</Button>
          </Dialog.Trigger>
          <Dialog.Content compact>
            <Dialog.Title>Delete project?</Dialog.Title>
            <Dialog.Description>
              Morning routine and its nine slides go with it. This cannot be undone.
            </Dialog.Description>
            <Dialog.Actions>
              <Dialog.Close asChild>
                <Button>Keep it</Button>
              </Dialog.Close>
              <Dialog.Close asChild>
                <Button variant="danger">Delete</Button>
              </Dialog.Close>
            </Dialog.Actions>
          </Dialog.Content>
        </Dialog.Root>
      </Specimen>
      <Specimen label="Popover">
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button>Custom ratio</Button>
          </Popover.Trigger>
          <Popover.Content aria-label="Custom ratio">
            <Stack gap={3}>
              <Inline gap={2}>
                <Field label="Width">
                  <Input inputSize="sm" defaultValue="9" />
                </Field>
                <Field label="Height">
                  <Input inputSize="sm" defaultValue="16" />
                </Field>
              </Inline>
              <Popover.Close asChild>
                <Button size="sm" variant="solid">
                  Apply
                </Button>
              </Popover.Close>
            </Stack>
          </Popover.Content>
        </Popover.Root>
      </Specimen>
      <Specimen label="Tooltip">
        <Tooltip content="Bring to front">
          <IconButton icon="front" label="Bring to front" />
        </Tooltip>
        <Tooltip content="Opens below" side="bottom">
          <Button>Below</Button>
        </Tooltip>
        <Tooltip content="Opens to the right" side="right">
          <Button>Right</Button>
        </Tooltip>
      </Specimen>
      <Specimen label="Tabs" column>
        <Tabs.Root defaultValue="slide">
          <Tabs.List aria-label="Inspector">
            <Tabs.Trigger value="slide">Slide</Tabs.Trigger>
            <Tabs.Trigger value="layers">Layers</Tabs.Trigger>
            <Tabs.Trigger value="export">Export</Tabs.Trigger>
            <Tabs.Trigger value="locked" disabled>
              Locked
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="slide">Background, ratio and safe areas.</Tabs.Content>
          <Tabs.Content value="layers">Order, crop and opacity.</Tabs.Content>
          <Tabs.Content value="export">Size, format and the preview chrome.</Tabs.Content>
          <Tabs.Content value="locked">Unreachable.</Tabs.Content>
        </Tabs.Root>
      </Specimen>
    </Section>
  );
}

function MenuSection() {
  const [ratio, setRatio] = useState("9:16");
  const [grid, setGrid] = useState(true);

  return (
    <Section
      id="menus"
      title="Menus"
      note="These two replace the five menus the old app hand rolled at app.js:641-932. Between them they cover everything those needed: a glyph per row, a destructive tint, a muted tag, an active mark, and opening at the pointer."
    >
      <Specimen label="Dropdown, commands">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button>Layer actions</Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item icon="crop">Crop</DropdownMenu.Item>
            <DropdownMenu.Item icon="front">Bring to front</DropdownMenu.Item>
            <DropdownMenu.Item icon="up">Bring up a level</DropdownMenu.Item>
            <DropdownMenu.Item icon="down">Bring down a level</DropdownMenu.Item>
            <DropdownMenu.Item icon="send-back" disabled>
              Bring to back
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item icon="trash" danger>
              Remove
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Specimen>
      <Specimen label="Dropdown, a choice">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button>Ratio</Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Label>Presets</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={ratio} onValueChange={setRatio}>
              <DropdownMenu.RadioItem value="9:16" tag="TikTok">
                Vertical
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="1:1" tag="Instagram">
                Square
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem value="4:5" tag="Suggested">
                Portrait
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator />
            <DropdownMenu.CheckboxItem checked={grid} onCheckedChange={setGrid}>
              Show the grid
            </DropdownMenu.CheckboxItem>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <span className={styles.swatchValue}>
          {ratio} · grid {grid ? "on" : "off"}
        </span>
      </Specimen>
      <Specimen label="A menu row outside a menu" column>
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button>Custom ratio</Button>
          </Popover.Trigger>
          <Popover.Content aria-label="Custom ratio">
            {/*
             * Pickable rows are as="button". The default arm is a readout and
             * refuses onClick, so a row cannot look pickable without being a
             * control the keyboard can reach.
             */}
            <MenuRow
              as="button"
              selected={ratio === "9:16"}
              tag="TikTok"
              onClick={() => {
                setRatio("9:16");
              }}
            >
              Vertical
            </MenuRow>
            <MenuRow
              as="button"
              selected={ratio === "1:1"}
              indicator
              tag="Instagram"
              onClick={() => {
                setRatio("1:1");
              }}
            >
              Square
            </MenuRow>
            <MenuSeparator />
            <MenuRow as="button" icon="crop">
              Enter a custom ratio
            </MenuRow>
            <MenuRow as="button" danger icon="trash">
              Reset to 9:16
            </MenuRow>
            <MenuRow as="button" disabled icon="send-back">
              Unavailable here
            </MenuRow>
            {/* A readout, not a control: no pointer cursor, no click handler. */}
            <MenuRow tag="1080 × 1920">Exports at</MenuRow>
          </Popover.Content>
        </Popover.Root>
        <span className={styles.swatchValue}>
          The presets above are a DropdownMenu and these are a Popover. A Radix menu
          cannot hold a form, so the custom ratio control of app.js:806 splits in two and
          MenuRow is what keeps the halves looking like one thing.
        </span>
      </Specimen>
      <Specimen label="Context menu" column>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div className={styles.contextTarget}>Right click anywhere in here</div>
          </ContextMenu.Trigger>
          <ContextMenu.Content compact>
            <ContextMenu.Item icon="image">Change</ContextMenu.Item>
            <ContextMenu.Item icon="trash" danger>
              Remove
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      </Specimen>
    </Section>
  );
}

function FeedbackSection() {
  const { toast } = useToast();

  return (
    <Section
      id="feedback"
      title="Feedback"
      note="A toast reports something that already happened, so it announces politely and waits its turn instead of cutting across whatever a screen reader is saying. A second message queues rather than deleting the first, which app.js:1148 did."
    >
      <Specimen label="Toast">
        <Button
          onClick={() => {
            toast("Slides are now 9:16 · 1080 × 1920");
          }}
        >
          Report a change
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            toast("Export failed. The slide is missing its background.", {
              tone: "danger",
            });
          }}
        >
          Report a failure
        </Button>
        <Button
          onClick={() => {
            toast("First");
            toast("Second");
            toast("Third");
          }}
        >
          Queue three
        </Button>
      </Specimen>
      <Specimen label="Static" column>
        <Toast open duration={Infinity}>
          Slides are now 9:16 · 1080 × 1920
        </Toast>
        <Toast open tone="danger" duration={Infinity}>
          Export failed. The slide is missing its background.
        </Toast>
      </Specimen>
    </Section>
  );
}

function IconSection() {
  return (
    <Section
      id="icons"
      title="Icons"
      note="The line art from app.js:1166-1192. A glyph with no title is aria-hidden, because an icon beside a label is decoration and reading it twice helps nobody."
    >
      <Specimen label={`${String(iconNames.length)} glyphs`}>
        {iconNames.map((name) => (
          <span className={styles.iconCell} key={name}>
            <Icon name={name} size={24} />
            {name}
          </span>
        ))}
      </Specimen>
    </Section>
  );
}

type ThemeChoice = "system" | "light" | "dark";

const themeItems = [
  { value: "system", label: "Follow the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function GalleryBody() {
  const [theme, setTheme] = useState<ThemeChoice>("system");

  /*
   * The theme goes on <html> rather than on the page wrapper, because every
   * overlay portals to the end of <body>. Pinning the wrapper would leave every
   * dialog, menu and toast following the operating system instead.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
      return;
    }
    root.setAttribute("data-theme", theme);
    return () => {
      root.removeAttribute("data-theme");
    };
  }, [theme]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Slide Studio design system</h1>
          <p className={styles.lede}>
            Every primitive in every documented state, the token scales as swatches, and
            light beside dark. Development only: this page is not in the production build.
          </p>
        </div>
        <div className={styles.themePicker}>
          <Field label="Theme">
            <Select
              items={themeItems}
              value={theme}
              onValueChange={(next) => {
                setTheme(next as ThemeChoice);
              }}
            />
          </Field>
        </div>
      </header>

      <nav className={styles.nav} aria-label="Sections">
        {sections.map(([id, label]) => (
          <a className={styles.navLink} href={`#${id}`} key={id}>
            {label}
          </a>
        ))}
      </nav>

      <TokenSection />

      <Section
        id="themes"
        title="Light and dark"
        note="Both panels pin a theme, so neither follows the machine you are reading this on. The token layer is the only thing that changes between them: no component carries a dark rule of its own."
      >
        <Specimen label="Palette" column>
          <ThemePair>
            <Swatches tokens={paletteTokens} />
          </ThemePair>
        </Specimen>
        <Specimen label="Surfaces" column>
          <ThemePair>
            <Swatches tokens={surfaceTokens} />
          </ThemePair>
        </Specimen>
        <Specimen label="Project status" column>
          <ThemePair>
            <Swatches tokens={statusTokens} />
          </ThemePair>
        </Specimen>
        <Specimen label="Primitives" column>
          <ThemePair>
            <ThemeSampler />
          </ThemePair>
        </Specimen>
      </Section>

      <ButtonSection />
      <FormSection />
      <ContentSection />
      <OverlaySection />
      <MenuSection />
      <FeedbackSection />
      <IconSection />
    </div>
  );
}

export function Gallery() {
  /*
   * The guard, so the page cannot appear in production even if a route is left
   * mounted by mistake. It is not the whole story: the mount site should also
   * gate on import.meta.env.DEV and reach this file through React.lazy, which is
   * what actually keeps it out of the shipped bundle.
   */
  if (!import.meta.env.DEV) return null;

  return (
    <Tooltip.Provider delayDuration={200}>
      <ToastProvider>
        <GalleryBody />
      </ToastProvider>
    </Tooltip.Provider>
  );
}

export default Gallery;
