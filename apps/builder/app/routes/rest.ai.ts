import type { ActionArgs } from "@remix-run/node";
import { isFeatureEnabled } from "@webstudio-is/feature-flags";
import { EmbedTemplateStyles, WsEmbedTemplate } from "@webstudio-is/react-sdk";
import { fromMarkdown as parseMarkdown } from "mdast-util-from-markdown";
import type {
  ChatCompletionRequestMessage,
  CreateChatCompletionResponse,
} from "openai";
import { visit } from "unist-util-visit";
import { z } from "zod";
import { zfd } from "zod-form-data";
import env from "~/env/env.server";

const StepSchema = z.enum(["instances", "styles"]);
type Step = z.infer<typeof StepSchema>;

type Steps = [Step, string][];
type Messages = (ChatCompletionRequestMessage[] | null)[];

const schema = zfd.formData({
  prompt: zfd.text(z.string().max(280)),
  steps: zfd.repeatableOfType(zfd.text(StepSchema)),
  messages: zfd.repeatableOfType(zfd.text().optional()),
});

type OpenAIConfig = {
  apiKey: string;
  organization: string;
  model: "gpt-3.5-turbo" | "gpt-4";
  maxTokens: number;
};

// @todo Add end-to-end types.

export const action = async ({ request }: ActionArgs) => {
  if (!isFeatureEnabled("ai")) {
    return { errors: ["Feature not available"] };
  }

  // @todo Add session checks and rate limiting.

  // @todo Incorporate embeddings to provide context to each step:
  // instances -> pick relevant components metadata with description etc.
  // props     -> pick props definitions for used components? This payload can be very long.
  // styles    -> pick examples?

  try {
    const formData = schema.parse(await request.formData());
    const userPrompt = formData.prompt.trim();
    const steps: Steps = formData.steps.map((step) => [step, templates[step]]);
    const messages: Messages = steps.map((_, index) => {
      const m = formData.messages[index];
      return typeof m === "string" ? JSON.parse(m) : null;
    });

    const result = await generate({
      userPrompt,
      steps,
      messages,
      config: {
        apiKey: env.OPENAI_KEY || "",
        organization: env.OPENAI_ORG || "",
        model: "gpt-3.5-turbo",
        maxTokens: 3000,
      },
    });

    return result;
  } catch (error) {
    return { errors: error.message };
  }

  return { errors: "Unexpected error" };
};

const validators = {
  instances: (json: unknown) => {
    WsEmbedTemplate.parse(json);
  },
  styles: (json: unknown) => {
    z.array(EmbedTemplateStyles).parse(json);
  },
};

export const generate = async function generate({
  userPrompt,
  steps,
  messages,
  config,
}: {
  userPrompt: string;
  steps: Steps;
  messages: Messages;
  config: OpenAIConfig;
}) {
  const { apiKey, organization, model, maxTokens }: OpenAIConfig = config;
  if (apiKey.trim().length === 0) {
    throw new Error("OpenAI API missing");
  }

  if (!organization.startsWith("org-")) {
    throw new Error("OpenAI org missing or invalid");
  }

  try {
    const chain = getChainForPrompt({
      prompt: userPrompt,
      steps,
      messages,
      complete: (messages) =>
        fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "OpenAI-Organization": organization,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            max_tokens: maxTokens,
          }),
        }).then((response) => {
          if (response.ok) {
            return response.json();
          }
          throw new Error(`${response.status}: ${response.statusText}`);
        }),
    });

    const responses = await chain();
    return responses.map(([step, response]) => {
      const json = getJSONCodeBlock(response);

      if (typeof validators[step] === "function") {
        try {
          validators[step](json);
        } catch (error) {
          const errorMessage = `Invalid ${step} generation. ${
            process.env.NODE_ENV === "production"
              ? ""
              : `${JSON.stringify(json, null, 2)}\n\n${error.message}`
          }`;
          throw new Error(errorMessage);
        }
      }

      return [step, Array.isArray(json) ? json : [json]];
    });
  } catch (error) {
    const errorMessage = `Something went wrong. ${
      process.env.NODE_ENV === "production" ? "" : `${(error as Error).message}`
    }`;
    if (process.env.NODE_ENV !== "production") {
      console.error(errorMessage);
    }
    throw new Error(errorMessage);
  }
};

const getChainForPrompt = function getChainForPrompt({
  prompt,
  steps,
  messages,
  complete,
}: {
  prompt: string;
  steps: Steps;
  messages: Messages;
  complete: (
    messages: ChatCompletionRequestMessage[]
  ) => Promise<CreateChatCompletionResponse>;
}) {
  return async function chain() {
    const responses: [Step, string][] = [];

    for (let i = 0; i < steps.length; i++) {
      const [step, template] = steps[i];

      const completionRequestMessages = [
        {
          role: "user",
          content: template.replace(/<!--prompt-content-->/, prompt).trim(),
        } as ChatCompletionRequestMessage,
      ];

      const messagesForStep = messages[i];
      if (messagesForStep !== null) {
        completionRequestMessages.unshift(...messagesForStep);
      } else if (i > 0 && responses[i - 1]) {
        completionRequestMessages.unshift({
          role: "assistant",
          content: responses[i - 1][1],
        });
      }

      const completion = await complete(completionRequestMessages);
      responses[i] = [step, completion.choices[0].message?.content || ""];
    }

    return responses;
  };
};

const getJSONCodeBlock = (text: string) => {
  const errorMsg = ["Parsing failed"];

  try {
    return JSON.parse(text.trim());
  } catch (error) {}

  try {
    const tree = parseMarkdown(text);
    const codeBlocks: string[] = [];

    visit(tree, "code", (node) => {
      if (node.lang === "json") {
        codeBlocks.unshift(node.value.trim());
      } else if (!node.lang) {
        codeBlocks.push(node.value.trim());
      }
    });

    if (codeBlocks.length > 0) {
      return JSON.parse(codeBlocks[0]);
    } else {
      errorMsg.push("No code blocks found");
    }
  } catch (error) {}

  if (process.env.NODE_ENV !== "production") {
    errorMsg.push(text);
  }

  throw new Error(errorMsg.join("\n\n"));
};

// @todo Iterate and refine the prompt templates.
// The ones below are very WIP and rudimental.
const templates = {
  instances: `
You are WebstudioGPT a no-code tool for designers that generates a JSON representation of UI markup.

Without using any dependency or external library, generate a JSON object for the following request:

<!--prompt-content-->

Respond in valid JSON that strictly follows the TypeScript definitions below:

\`\`\`typescript
type EmbedTemplateText = {
  type: "text";
  value: string;
};

type EmbedTemplateInstance = {
  type: "instance";
  /*
    component can be:
    - Box: a container element
    - Heading: typography element used for headings and titles
    - TextBlock: typography element for generic blocks of text (eg. a paragraph)
    - Link: a text link
    - List: a bulleted or numbere list container element
    - List Item: a item in a List component
    - Input: an input field component
    - Label: a label for an Input or TextArea component
    - TextArea: a multi line input field component
    - RadioButton: a radio input component
    - Checkbox: a checkbox field
    - Button: a button component
  */
  component: string;
  children: Array<EmbedTemplateInstance | EmbedTemplateText>;
};

type JSONResult = Array<EmbedTemplateInstance | EmbedTemplateText>
\`\`\`

Below is an example of valid output:

\`\`\`json
[
  { type: "text", value: "hello" },
  {
    type: "instance",
    component: "Box",
    children: [
      { type: "instance", component: "Box", children: [] },
      { type: "text", value: "world" },
    ],
  },
]
\`\`\`

Omit information like "props" that are not in the TypeScript definitions above.`,
  styles: `Given the "input JSON" object representing a UI component structure provided in the previous message, your task is to generate a new JSON object representing **only** the styles for the components in that structure. Ensure that the existing properties such as "type" or "component" are not repeated in the output JSON. Don't generate styles for elements with "type" equal to "text".

User Request that generated the "input JSON": "<!--prompt-content-->".

Respond in valid JSON that strictly follows the TypeScript definitions below:

\`\`\`typescript
type JSONResult = EmbedTemplateStyles[];

type EmbedTemplateStyles = {
  styles: EmbedTemplateStyleDecl[],
  children?: EmbedTemplateStyles[]
};

type EmbedTemplateStyleDecl = {
  state?: string,
  /*
   property's values are camelCase e.g. flexDirection.
  */
  property: string;
  value:
    | {
        type: "keyword";
        value: string;
      }
    | {
        type: "fontFamily";
        value: string[];
      }
    | {
        type: "rgb";
        r: number;
        g: number;
        b: number;
        alpha: number;
      }
    | {
        type: "invalid";
        value: string;
      }
    | {
        type: "unset";
        value: "";
      }
    | Units;
};

type Units = {
  type: "unit";
  value: number;
  /* unit is a ValidCSSUnit (string) or the string literal "number" for unitless numbers */
  unit: ValidCSSUnit | "number";
};
\`\`\`

Comments in the code block provide further context for the immediate key that follows.

Example result:

\`\`\`json
[{"styles":[{"property":"display","value":{"type":"keyword","value":"flex"}},{"property":"flexDirection","value":{"type":"keyword","value": "column"}}],"children":[{"styles":[{"property":"marginBottom","value":{"type":"unit","value": 10,"unit":"px"}}]},{"styles":[{"property":"marginBottom","value":{"type":"unit","value": 10,"unit":"px"}}]}]}]
\`\`\``,
};
