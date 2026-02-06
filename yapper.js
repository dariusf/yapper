const { spawn } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const { Telegraf, Markup } = require("telegraf");

const Logger = (function () {
  var logStream;

  function close() {
    logStream.end();
  }

  function init() {
    logStream = fs.createWriteStream("interactions.log", { flags: "a" });

    logStream.on("error", (err) => {
      console.error(`[ERROR] Log stream error: ${err.message}`);
    });

    process.once("SIGINT", () => {
      close();
    });
    process.once("SIGTERM", () => {
      close();
    });
  }

  function log(sender, message) {
    const timestamp = new Date().toLocaleString();
    const entry = `[${timestamp}] ${sender}:\n${message}\n${"=".repeat(20)}\n`;
    logStream.write(entry);
  }

  return { init, log };
})();

const Tele = (function () {
  var lastChatId;

  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  function hasConversationStarted() {
    return lastChatId !== undefined;
  }

  async function sendMessage(text, ...args) {
    if (text === "") return;

    // avoid 400 message too long. we could also send
    // multiple messages but that seems unnecessary.
    const suffix = "... (truncated)";
    text = text.sub(0, 4096 - suffix.length);

    return await bot.telegram.sendMessage(lastChatId, text, ...args);
  }

  function securityCheck(ctx) {
    if (ctx.chat.username !== process.env.ALLOWED_USERNAME) {
      console.warn(
        `[SECURITY] Unauthorized access attempt by user: ${ctx.chat.username}`,
      );
      return false;
    }
    return true;
  }

  function setupBot() {
    // bot.start((ctx) => ctx.reply("Welcome"));
    // bot.help((ctx) => ctx.reply("Send me a sticker"));
    // bot.on(message("sticker"), (ctx) => ctx.reply("👍"));
    // bot.hears("hi", (ctx) => ctx.reply("Hey there"));

    bot.command("health", (ctx) => {
      if (!securityCheck(ctx)) return;
      ctx.reply(`Seems okay? ${Agent.getStatus()}`);
    });

    bot.command("clear", (_) => {
      if (!securityCheck(ctx)) return;
      // ctx.reply("started over");
      Logger.log("COMMAND", "/clear");
      Agent.initSession();
    });

    // bot.command("thoughts", (ctx) => {
    //   if (!securityCheck(ctx)) return;
    //   const thinking = Agent.toggleThinking();
    //   Logger.log("COMMAND", `/thoughts (thinking: ${thinking})`);
    //   ctx.reply(`Thinking: ${thinking}`);
    // });

    bot.on("message", async (ctx) => {
      // console.log(`[MESSAGE]: ${JSON.stringify(ctx.chat, null, 2)}`);
      // console.log(`[MESSAGE]: ${JSON.stringify(ctx.message, null, 2)}`);
      if (!securityCheck(ctx)) return;
      // ctx.reply('Understood')
      ctx.react("👍");
      const msg = ctx.message.text;
      Logger.log("USER", msg);
      lastChatId = ctx.chat.id;
      Agent.sendPrompt(msg);
    });

    bot.action("proceed_always", async (ctx) => {
      try {
        // this may fail if invoked twice, due to a double press
        // before the edit can take place
        await ctx.editMessageReplyMarkup(undefined);
        Logger.log("USER_ACTION", "proceed_always");
        // this does not seem to work in gemini
        Agent.sendToolCallResponse("proceed_always");
        ctx.answerCbQuery("Allowing always");
      } catch (e) {
        console.error(e.message);
      }
    });
    bot.action("proceed_once", async (ctx) => {
      try {
        await ctx.editMessageReplyMarkup(undefined);
        Logger.log("USER_ACTION", "proceed_once");
        Agent.sendToolCallResponse("proceed_once");
        ctx.answerCbQuery("Allowing once");
      } catch (e) {
        console.error(e.message);
      }
    });
    bot.action("cancel", async (ctx) => {
      try {
        await ctx.editMessageReplyMarkup(undefined);
        Logger.log("USER_ACTION", "cancel");
        Agent.sendToolCallResponse("cancel");
        ctx.answerCbQuery("Cancelled");
      } catch (e) {
        console.error(e.message);
      }
    });

    bot.launch();

    // Enable graceful stop
    process.once("SIGINT", () => {
      bot.stop("SIGINT");
    });
    process.once("SIGTERM", () => {
      bot.stop("SIGTERM");
    });
  }

  function init() {
    setupBot();
  }

  return {
    hasConversationStarted,
    sendMessage,
    init,
  };
})();

const Agent = (function () {
  var sessionId;
  var lastToolCallId;

  var textBuffer = [];
  function bufferText(t) {
    textBuffer.push(t);
  }
  function flushBuffer() {
    const r = textBuffer.join("");
    textBuffer = [];
    return r;
  }

  var thinking = false;
  function toggleThinking() {
    thinking = !thinking;
    return thinking;
  }

  let messageId = 1;

  // -s doesn't work with this?
  const gemini = spawn("gemini", ["--experimental-acp"]);
  gemini.on("error", (err) => {
    console.error(`[ERROR] Failed to spawn gemini process: ${err.message}`);
    console.error(
      "Please ensure the 'gemini' executable is installed and in your PATH.",
    );
    process.exit(1);
  });

  function getStatus() {
    let msg = `${textBuffer.length} buffered messages`;
    if (textBuffer.length > 0) {
      msg += `, last was "${textBuffer[textBuffer.length - 1]}"`;
    }
    return msg;
  }

  // Helper to send JSON-RPC requests
  function sendRequest(method, params = {}) {
    const request = {
      jsonrpc: "2.0",
      id: messageId++,
      method,
      params,
    };
    gemini.stdin.write(JSON.stringify(request) + "\n");
    console.log(`[CLIENT -> AGENT]: ${method}`);
  }

  function sendToolCallResponse(optionId) {
    const req = {
      jsonrpc: "2.0",
      id: lastToolCallId,
      result: {
        outcome: {
          outcome: "selected",
          optionId,
        },
      },
    };
    gemini.stdin.write(JSON.stringify(req) + "\n");
    console.log(`[CLIENT -> AGENT]: selected ${optionId}`);
  }

  function sendPrompt(text) {
    if (!sessionId) return;

    sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  function startNewSession() {
    sendRequest("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
  }

  async function agentHandler(line) {
    const response = JSON.parse(line);

    // Log thoughts or chunks if they arrive (streaming)

    // if (response.method === "session/update") {
    //   const update = response.params.update;
    //   if (update.sessionUpdate === "agent_message_chunk") {
    //     process.stdout.write(`Agent: ${update.content}`);
    //   }
    //   return;
    // }

    console.log(`[AGENT -> CLIENT]:`, JSON.stringify(response, null, 2));

    // simple state machine for handshake
    if (response.result && response.id === 1) {
      // response to `initialize`
      sendRequest("authenticate", {
        methodId: "oauth-personal",
      });
    } else if (response.result && response.id === 2) {
      // response to authenticate`
      startNewSession();
    } else if (
      (response.result && response.id === 3) ||
      response?.result?.sessionId
    ) {
      // response to `session/new`
      sessionId = response.result.sessionId;
      console.log("READY");
      if (Tele.hasConversationStarted()) {
        // this runs both at startup (before a conversation is
        // started), and upon user request to clear the context
        await Tele.sendMessage("Ready!");
      }
    } else if (response.method === "session/update") {
      const txt = response.params.update.content.text;
      // TODO this may be a tool call
      if (response.params.update.sessionUpdate === "agent_thought_chunk") {
        if (thinking) {
          bufferText(txt);
        }
      } else if (
        response.params.update.sessionUpdate === "agent_message_chunk"
      ) {
        bufferText(txt);
      } else if (response.params.update.sessionUpdate === "tool_call") {
        // await Tele.sendMessage(flushBuffer());
        // const toolCallKind = response.params.update.toolCallId.split("-")[0];
        // const title = response.params.update.title;
        // await Tele.sendMessage(`Tool: ${toolCallKind} ${title}`);
      } else if (response.params.update.sessionUpdate === "tool_call_update") {
        // await Tele.sendMessage(flushBuffer());
        // const toolCallKind = response.params.update.toolCallId.split("-")[0];
        // const status = response.params.update.status;
        // await Tele.sendMessage(`Tool: ${toolCallKind} ${status}`);
      } else {
        console.log("session/update message not handled yet");
      }
    } else if (response?.result?.stopReason === "end_turn") {
      const fullMessage = flushBuffer();
      await Tele.sendMessage(fullMessage);
      Logger.log("AGENT", fullMessage);
      console.log("-------------");
    } else if (response.method === "session/request_permission") {
      lastToolCallId = response.id;

      // send everything up to this point
      await Tele.sendMessage(flushBuffer());

      // confirmation buttons
      const options = response.params.options.map((o) => [
        Markup.button.callback(o.name, o.optionId),
      ]);
      const keyboard = Markup.inlineKeyboard(
        options,
        // [
        // [Markup.button.callback("Option 1", "opt1")],
        // [Markup.button.callback("Option 2", "opt2")],
        // ]
      );
      const toolCallKind = response.params.toolCall.toolCallId.split("-")[0];
      const toolCallMsg = `Allow ${toolCallKind}?

${response.params.toolCall.title}
`;
      // \`\`\`
      Logger.log("TOOL_REQUEST", toolCallMsg);
      await Tele.sendMessage(toolCallMsg, keyboard);
    } else if (response.error) {
      const msg = `${response.error.message}

${response.error.data.details}`;
      await Tele.sendMessage(msg);
    } else {
      console.log("message not handled yet");
    }
  }

  function init() {
    const rl = readline.createInterface({
      input: gemini.stdout,
      terminal: false,
    });

    // handle agent responses
    rl.on("line", async (line) => {
      try {
        return await agentHandler(line);
      } catch (e) {
        await Tele.sendMessage(`An error occurred: ${e.message}`);
        console.trace();
      }
    });

    gemini.stderr.on("data", (data) => {
      console.error(`[STDERR]: ${data}`);
    });

    sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "NodeHelloWorld", version: "1.0.0" },
      capabilities: {},
    });
  }

  return {
    init,
    sendPrompt,
    sendToolCallResponse,
    startNewSession,
    toggleThinking,
    getStatus,
  };
})();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN environment variable is not set.");
  process.exit(1);
}

if (!process.env.ALLOWED_USERNAME) {
  console.error("Error: ALLOWED_USERNAME environment variable is not set.");
  process.exit(1);
}

Logger.init();
Tele.init();
Agent.init();
