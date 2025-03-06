const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json()); // for parsing JSON request bodies

// Load env variables
const SRC_ENDPOINT = process.env.SRC_ENDPOINT;           // e.g. https://my-sourcegraph-instance.com
const SRC_ACCESS_TOKEN = process.env.SRC_ACCESS_TOKEN;   // your Sourcegraph token

// ----------------------------------------------------------------------
// 1) Implement GET /v1/models by calling Cody's .api/llm/models
// ----------------------------------------------------------------------
app.get("/v1/models", async (req, res) => {
  try {
    //  Forward to Sourcegraph's /llm/models
    const sgResp = await axios.get(`${SRC_ENDPOINT}/.api/llm/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `token ${SRC_ACCESS_TOKEN}`,
        'X-Requested-With': 'something 1.0',
      },
    });

    // Transform Sourcegraph model list into OpenAI style
    // Sourcegraph returns: { data: [ { id, object, created, owned_by } ] }
    // OpenAI returns something like: { object: "list", data: [ { id, object, created, owned_by } ] }
    // Actually it's *almost identical*, so minimal transformation needed:
    const transformed = {
      object: "list",
      data: sgResp.data.data.map((m) => ({
        id: m.id,
        object: m.object,    // "model"
        created: m.created,
        owned_by: m.owned_by
      })),
    };
    // send it back
    return res.json(transformed);
  } catch (err) {
    console.error("Error in /v1/models:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to list models from Sourcegraph" });
  }
});

// ----------------------------------------------------------------------
// 2) Implement POST /v1/chat/completions
// ----------------------------------------------------------------------
app.post("/chat/completions", async (req, res) => {
  try {
    // The user is sending something like
    // {
    //   model: "gpt-4",
    //   messages: [{ role: "user", content: "Hello" }],
    //   temperature: 0.7, ...
    // }

    // In Sourcegraph’s /llm/chat/completions, the expected body is:
    // {
    //   "messages": [ { role: "...", content: "..." } ],
    //   "model": "...",
    //   "max_tokens": 1000,
    //   ...
    // }

        console.log("POST /chat/completions", req.body);

    // 1) read relevant fields from the OpenAI request
    const {
      model,
      messages,
      temperature,
      max_tokens,
      // ... other fields you want
    } = req.body;

    // 2) build the Sourcegraph request body
    const sgBody = {
      model: model, // e.g. "anthropic::2023-06-01::claude-3.5-sonnet"
      messages: messages,
    };
    if (max_tokens) {
      sgBody.max_tokens = max_tokens; 
    }
    if (temperature !== undefined) {
      sgBody.temperature = temperature;
    }

    // 3) make the request
    const sgResp = await axios.post(
      `${SRC_ENDPOINT}/.api/llm/chat/completions`,
      sgBody,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `token ${SRC_ACCESS_TOKEN}`,
          "X-Requested-With": 'something 1.0',
        },
      }
    );

    // 4) transform the Sourcegraph response to OpenAI style
    // Sourcegraph returns something like:
    // {
    //   id, model, object, usage, ...
    //   choices: [
    //       { message: { role, content }, finish_reason, index }
    //   ]
    // }
    // We want to produce the standard OpenAI "chat.completion" shape:
    // {
    //   id, object: "chat.completion", created, model, usage, choices: [...]
    // }

    const codyData = sgResp.data; // The raw Sourcegraph response
    const openAIResponse = {
      id: codyData.id,
      object: "chat.completion",
      created: codyData.created || Math.floor(Date.now()/1000),
      model: codyData.model,
      usage: codyData.usage,
      choices: (codyData.choices || []).map((choice, i) => ({
        index: i,
        message: {
          role: choice.message?.role,
          content: choice.message?.content,
        },
        finish_reason: choice.finish_reason || "stop",
      })),
    };

    // 5) return it
    console.log("POST /chat/completions response:", openAIResponse);
    return res.json(openAIResponse);

  } catch (err) {
    console.error("Error in /v1/chat/completions:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to create chat completion from Sourcegraph" });
  }
});

// OPTIONAL: If your local clients call /v1/completions, implement similarly
// app.post("/v1/completions", ... )

// Start the server
console.log('Something something');
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`OpenAI-compatible local server listening on port ${PORT}`);
});
