
```sh
git clone git@github.com:dariusf/yapper.git $YAPPER_PATH
cd $YAPPER_PATH
npm install

cd $YOUR_PROJECT
export TELEGRAM_BOT_TOKEN=$YOUR_TOKEN
export ALLOWED_USERNAME=$YOUR_TELEGRAM_USERNAME
$YAPPER_PATH/start.sh
```
