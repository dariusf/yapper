
```sh
git clone git@github.com:dariusf/yapper.git $YAPPER_PATH
cd $YAPPER_PATH
npm install

cd $YOUR_PROJECT
export TELEGRAM_BOT_TOKEN=$YOUR_TOKEN
export ALLOWED_USERNAME=$YOUR_TELEGRAM_USERNAME
$YAPPER_PATH/start.sh
```

<!--
Prior work

https://old.reddit.com/r/GeminiCLI/comments/1mwkof2/built_a_telegram_server_for_remote_gemini_cli/

MCP servers
https://github.com/sparfenyuk/mcp-telegram
https://github.com/chigwell/telegram-mcp
-->