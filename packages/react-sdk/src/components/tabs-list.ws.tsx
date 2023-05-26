import { BoxIcon } from "@webstudio-is/icons/svg";
import type {
  PresetStyle,
  WsComponentMeta,
  WsComponentPropsMeta,
} from "./component-meta";
import { props } from "./__generated__/tabs-list.props";
import { div } from "../css/normalize";
import type { defaultTag } from "./tabs-list";

const presetStyle = {
  div,
} satisfies PresetStyle<typeof defaultTag>;

export const meta: WsComponentMeta = {
  type: "container",
  label: "Tabs List",
  icon: BoxIcon,
  acceptedParents: ["Tabs"],
  presetStyle,
  states: [
    { selector: "[data-orientation=vertical]", label: "Vertical orientation" },
    {
      selector: "[data-orientation=horizontal]",
      label: "Horizontal orientation",
    },
  ],
};

export const propsMeta: WsComponentPropsMeta = {
  props,
  initialProps: ["loop"],
};
