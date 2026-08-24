import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
// Deliberately the public surface rather than ./menu.js. index.ts states the rule
// in its own header, "screens import from here, never from a primitive's folder",
// so the test that proves Task 16 can build the custom ratio panel has to obey it.
import { Button, DropdownMenu, MenuRow, MenuSeparator, Popover } from "../index.js";

/*
 * The ratio control of app.js:806 is one panel of preset rows plus a form. A
 * Radix menu cannot hold a form, so it becomes a DropdownMenu beside a Popover,
 * and the two halves have to read as one object. These tests are the guard on
 * that: they compare a MenuRow in a Popover against a real menu row, property by
 * property, so the pair cannot drift.
 */
function BothHalves() {
  return (
    <>
      {/* Both held open, and modal={false} so the menu does not lock the popover out. */}
      <DropdownMenu.Root open modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button>Ratio</Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.RadioGroup value="9:16">
            <DropdownMenu.RadioItem value="9:16" tag="TikTok">
              Vertical
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="1:1" tag="Instagram">
              Square
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon="crop">Crop to fit</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <Popover.Root open>
        <Popover.Trigger asChild>
          <Button>Custom</Button>
        </Popover.Trigger>
        <Popover.Content aria-label="Custom ratio" data-testid="custom-panel">
          <MenuRow indicator tag="Custom" data-testid="plain-row">
            Vertical
          </MenuRow>
          <MenuRow selected tag="TikTok" data-testid="selected-row">
            Square
          </MenuRow>
          <MenuSeparator />
          <MenuRow icon="crop" data-testid="icon-row">
            Crop to fit
          </MenuRow>
          <MenuRow as="button" danger icon="trash" data-testid="danger-row">
            Reset
          </MenuRow>
          <MenuRow indicator icon="crop" data-testid="both-row">
            Crop to fit
          </MenuRow>
          <MenuRow as="button" disabled data-testid="disabled-row">
            Unavailable
          </MenuRow>
          <MenuRow data-testid="readout-row" tag="1080 × 1920">
            Exports at
          </MenuRow>
        </Popover.Content>
      </Popover.Root>
    </>
  );
}

/*
 * Two layers are held open at once here, and each hides the other from the
 * accessibility tree, which is what those layers are for. Painting is a DOM and
 * CSS question, so these read the DOM.
 */
function find(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`nothing matched ${selector}`);
  return element;
}

/* The second preset, the unchecked one, so it pairs with a plain MenuRow. */
const preset = () => find('[role="menuitemradio"][aria-checked="false"]');
const command = () => find('[role="menuitem"]');
const row = (name: string) => find(`[data-testid="${name}"]`);

const measured = [
  "minHeight",
  "paddingLeft",
  "paddingRight",
  "borderRadius",
  "fontSize",
  "fontWeight",
  "columnGap",
  "textAlign",
  "color",
];

function differences(a: Element, b: Element): string[] {
  const left = getComputedStyle(a);
  const right = getComputedStyle(b);
  return measured.filter(
    (property) => left.getPropertyValue(property) !== right.getPropertyValue(property),
  );
}

const labelOffset = (element: Element) => {
  const label = [...element.querySelectorAll("span")].at(-1);
  return (
    (label?.getBoundingClientRect().left ?? 0) - element.getBoundingClientRect().left
  );
};

it("paints a MenuRow exactly like a real menu row", async () => {
  await render(<BothHalves />);
  expect(differences(preset(), row("selected-row"))).toEqual([]);
  expect(differences(command(), row("icon-row"))).toEqual([]);
});

it("puts the label of a MenuRow in the same column as a menu row's", async () => {
  await render(<BothHalves />);
  // The reserved indicator column is why the two halves line up. Without it the
  // popover's labels would sit a glyph and a gap left of the presets above them.
  expect(labelOffset(row("selected-row"))).toBeCloseTo(labelOffset(preset()), 1);
  expect(labelOffset(row("plain-row"))).toBeCloseTo(labelOffset(preset()), 1);
  expect(labelOffset(row("icon-row"))).toBeCloseTo(labelOffset(command()), 1);
});

it("costs a column per thing the row asks for", async () => {
  await render(<BothHalves />);
  const oneColumn = labelOffset(row("plain-row"));
  const twoColumns = labelOffset(row("both-row"));
  // A row with both a reserved indicator and a leading glyph carries two columns.
  // Without this the parity tests above would pass on a row that had dropped one.
  expect(twoColumns).toBeGreaterThan(oneColumn);
  expect(labelOffset(row("icon-row"))).toBeCloseTo(oneColumn, 1);
});

it("draws the check only on the selected row", async () => {
  await render(<BothHalves />);
  const inIndicator = (name: string) =>
    row(name).firstElementChild?.querySelectorAll("svg").length;
  expect(inIndicator("selected-row")).toBe(1);
  expect(inIndicator("plain-row")).toBe(0);
});

it("tints a destructive row the same as a destructive menu row", async () => {
  await render(<BothHalves />);
  const danger = row("danger-row");
  expect(getComputedStyle(danger).color).toBe("rgb(167, 33, 58)");
  // as="button" makes the row a real control, so its click has a keyboard
  // equivalent rather than being a handler hung on a div.
  expect(danger.tagName).toBe("BUTTON");
  expect(danger.getAttribute("type")).toBe("button");
});

it("fades a disabled row the way a disabled menu row fades", async () => {
  await render(<BothHalves />);
  const disabled = row("disabled-row");
  // disabled belongs to a control, so it lives on the button arm and is the real
  // attribute rather than a data hook that only changes the paint.
  expect((disabled as HTMLButtonElement).disabled).toBe(true);
  expect(parseFloat(getComputedStyle(disabled).opacity)).toBeLessThan(1);
});

/*
 * The default arm is a readout, and it must not offer an affordance it cannot
 * honour. A div with cursor: pointer and a click handler is a control the
 * keyboard cannot reach and a screen reader does not announce as actionable,
 * which is exactly what the five legacy menus did wrong.
 */
it("does not make a readout row look clickable", async () => {
  await render(<BothHalves />);
  expect(getComputedStyle(row("readout-row")).cursor).toBe("default");
  expect(row("readout-row").tagName).toBe("DIV");
});

it("does make a control row look clickable, and reach the keyboard", async () => {
  await render(<BothHalves />);
  const control = row("danger-row") as HTMLButtonElement;
  expect(getComputedStyle(control).cursor).toBe("pointer");
  expect(control.tagName).toBe("BUTTON");
  // A real button is in the tab order and answers Enter and Space for free.
  expect(control.tabIndex).toBe(0);
});

it("fires a control row from the keyboard, not only from the mouse", async () => {
  let presses = 0;
  await render(
    <MenuRow
      as="button"
      data-testid="pressable"
      onClick={() => {
        presses += 1;
      }}
    >
      Enter a custom ratio
    </MenuRow>,
  );
  const control = row("pressable") as HTMLElement;
  control.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard(" ");
  expect(presses).toBe(2);
});

/*
 * A compile-time test. If the div arm ever accepts onClick again, this
 * @ts-expect-error becomes unused and both typechecks fail, which is the whole
 * point: the trap cannot reopen without someone being told.
 */
it("refuses a click handler on a readout row", () => {
  const offer = () => (
    // @ts-expect-error onClick is refused on the div arm on purpose, so a
    // pickable row has to be as="button". If this stops erroring the guard is gone.
    <MenuRow onClick={() => undefined}>Vertical</MenuRow>
  );
  expect(typeof offer).toBe("function");
});

it("gives a MenuRow control the shared focus ring", async () => {
  await render(<BothHalves />);
  const danger = row("danger-row") as HTMLElement;
  await userEvent.click(danger);
  danger.focus();
  const style = getComputedStyle(danger);
  expect(style.outlineStyle).toBe("solid");
  expect(style.boxShadow).toContain("rgb(21, 21, 21) 0px 0px 0px 5px");
});

it("separates two groups of rows with the same rule a menu uses", async () => {
  await render(<BothHalves />);
  const ours = find('[data-testid="custom-panel"] [role="separator"]');
  const theirs = find('[role="menu"] [role="separator"]');
  expect(parseFloat(getComputedStyle(ours).height)).toBeGreaterThan(0);
  expect(getComputedStyle(ours).backgroundColor).toBe(
    getComputedStyle(theirs).backgroundColor,
  );
});
