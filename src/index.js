const assert = require('assert');
const base32 = require('thirty-two');
const crypto = require('crypto');
const fetch = require('node-fetch');
const lodash = require('lodash');
const Promise = require('bluebird');
const Koa = require('koa');
const KoaRouter = require('koa-router');
const bodyParser = require('koa-bodyparser');
const logger = require('winston');

const app = new Koa();
const api = KoaRouter();

const configDefault = {
    port: 8080,
    namespace: 'authbot',
    redisHost: '127.0.0.1',
    loginExpire: 30,
    sessionExpire: 300,
    cookieExpire: 60000,
    sendTimeout: 8000,
    redirectAuth: '/auth',
    redirectNoAuth: '/noauth',
    loggerLevel: 'debug'
};

const configMeta = {
    domain: {
        description: 'HTTPS web domain to auth access',
        example: 'authdemo.webserva.com'
    },
    bot: {
        description: 'Telegram Bot name i.e. this authbot',
        example: 'ExAuthDemoBot',
        info: 'https://core.telegram.org/bots/api',
        hint: 'https://telegram.me/BotFather'
    },
    secret: {
        description: 'Telegram Bot secret',
        example: 'z7WnDUfuhtDCBjX54Ks5vB4SAdGmdzwRVlGQjWBt',
        info: 'https://core.telegram.org/bots/api#setwebhook',
        hint: 'https://github.com/evanx/random-base56'
    },
    token: {
        description: 'Telegram Bot token',
        example: '243751977:AAH-WYXgsiZ8XqbzcqME7v6mUALxjktvrQc',
        info: 'https://core.telegram.org/bots/api#authorizing-your-bot',
        hint: 'https://telegram.me/BotFather'
    },
    account: {
        description: 'Authoritative Telegram username',
        example: 'evanxsummers',
        info: 'https://telegram.org'
    },
    telebotRedis: {
        description: 'Remote redis for bot messages, especially for development',
        example: 'redis://localhost:6333',
        info: 'https://github.com/evanx/webhook-push'
    }
};

const state = {};
const configFile = (!process.env.configFile? null: require(process.env.configFile));
const configKeys = [];
const missingConfigKeys = [];
const config = Object.keys(configMeta)
.concat(Object.keys(configDefault))
.reduce((config, key) => {
    if (process.env[key]) {
        assert(process.env[key] !== '', key);
        config[key] = process.env[key];
        configKeys.push(key);
    } else if (configFile && configFile[key]) {
        config[key] = configFile[key];
        configKeys.push(key);
    } else if (!configDefault[key] && configMeta[key].required !== false) {
        missingConfigKeys.push(key);
    }
    return config;
}, configDefault);
if (missingConfigKeys.length) {
    const sp = Array(3).join(' ');
    console.error(`Missing configs:`);
    console.error(lodash.flatten(missingConfigKeys.map(key => {
        const meta = configMeta[key];
        const lines = [`${sp}${key} e.g. '${meta.example}'`];
        if (meta.description) {
            lines.push(`${sp}"${meta.description}"`);
        }
        if (meta.info) {
            lines.push(`${sp}see ${meta.info}`);
        }
        if (meta.hint) {
            lines.push(`${sp}see ${meta.hint}`);
        }
        return lines;
    })).join('\n'));
    console.error('\nExample start:');
    console.error([
        ...configKeys.map(key => {
            return `${sp}${key}='${config[key]}' \\`;
        }),
        ...missingConfigKeys.map(key => {
            const meta = configMeta[key];
            return `${sp}${key}='' \\`;
        }),
        `${sp}npm start`
    ].join('\n'));
    console.error('\nTest Docker build:');
    console.error([
        `${sp}docker build -t telegrambot-auth:test git@github.com:evanx/telegrambot-auth.git`
    ].join('\n'));
    console.error('\nExample Docker run:');
    console.error([
        `${sp}docker run -t ${config.namespace}:test -d \\`,
        ...configKeys.map(key => {
            return `${sp+sp}-e ${key}='${config[key]}' \\`;
        }),
        ...missingConfigKeys.map(key => {
            const meta = configMeta[key];
            return `${sp+sp}-e ${key}='' \\`;
        }),
        `${sp+sp}${config.namespace}-test`
    ].join('\n'));
    process.exit(1);
}

logger.level = config.loggerLevel;

state.redirectNoAuth = process.env.redirectNoAuth || `https://telegram.me/${config.bot}`;
state.botUrl = `https://api.telegram.org/bot${config.token}`;

if (configFile && process.env.NODE_ENV === 'development') {
    [
        `https://${configFile.webhookDomain}/webhook/${config.secret}`,
        `https://${config.domain}/authbot/webhook/${config.secret}`
    ].forEach(webhookUrl => {
        const apiUrl = `${state.botUrl}/setWebhook?url=${encodeURI(webhookUrl)}`;
        console.log(`curl '${apiUrl}' | jq '.'`);
    });
    console.log(`\nssh -L${configFile.forwardedPort}:127.0.0.1:6379 ${configFile.remoteHost}`);
    const subscribeChannel = [configFile.remoteNamespace, config.secret].join(':');
    console.log(`\nredis-cli -p ${configFile.forwardedPort} subscribe "${subscribeChannel}"\n`);
    console.log([
        ...Object.keys(config).map(key => `${key}=${config[key]}`),
        'npm run development'
    ].join(' '));
}

const redis = require('redis');
const sub = redis.createClient(config.telebotRedis);
const client = redis.createClient(6379, config.redisHost);

assert(process.env.NODE_ENV);

async function multiExecAsync(client, multiFunction) {
    const multi = client.multi();
    multiFunction(multi);
    return Promise.promisify(multi.exec).call(multi);
}

function generateToken(length = 16) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const charset = '0123456789' + letters + letters.toLowerCase();
    return crypto.randomBytes(length).map(value => charset[Math.floor(value * charset.length / 256)]).join('');
}

(async function() {
    state.started = Math.floor(Date.now()/1000);
    state.pid = process.pid;
    logger.info('start', {config, state});
    if (process.env.NODE_ENV === 'development') {
        return startDevelopment();
    } else if (process.env.NODE_ENV === 'test') {
        return startTest();
    } else {
        return startProduction();
    }
}());

async function startTest() {
    return start();
}

async function startDevelopment() {
    return start();
}

async function startProduction() {
    return start();
}

async function start() {
    sub.on('message', (channel, message) => {
        logger.debug({channel, message});
        handleMessage(JSON.parse(message));
    });
    sub.subscribe('telebot:' + config.secret);
    return startHttpServer();
}

async function startHttpServer() {
    api.post('/webhook/*', async ctx => {
        ctx.body = '';
        const id = ctx.params[0];
        if (id !== config.secret) {
            logger.debug('invalid', ctx.request.url);
        } else {
            await handleMessage(ctx.request.body);
        }
    });
    api.get('/login/:username/:token', async ctx => {
        await handleLogin(ctx);
    });
    api.get('/logout/:username', async ctx => {
        await handleLogout(ctx);
    });
    app.use(api.routes());
    app.use(async ctx => {
        ctx.status = 404;
    });
    state.server = app.listen(config.port);
}

async function handleLogout(ctx) {
}

async function handleLogin(ctx) {
    const ua = ctx.get('User-Agent');
    logger.debug('handleLogin', ua);
    if (ua.startsWith('TelegramBot')) {
        ctx.status = 403;
        return;
    }
    const {username, token} = ctx.params;
    const loginKey = [config.namespace, 'login', token].join(':');
    const [hgetall] = await multiExecAsync(client, multi => {
        multi.hgetall(loginKey);
    });
    logger.debug('login', ua, loginKey, hgetall);
    if (!hgetall) {
        ctx.status = 403;
        ctx.redirect(state.redirectNoAuth);
        return;
    }
    assert.equal(hgetall.username, username, 'id');
    const sessionId = [token, generateToken(16)].join('_');
    const sessionRedisKey = [config.namespace, 'session', sessionId].join(':');
    const [hmset] = await multiExecAsync(client, multi => {
        multi.hmset(sessionRedisKey, {username});
        multi.expire(sessionRedisKey, config.sessionExpire);
        multi.del(loginKey);
    });
    ctx.cookie('sessionId', sessionId, {maxAge: config.cookieExpire, domain: config.domain});
    ctx.redirect(config.redirectAuth);
}

async function handleMessage(message) {
    const from = message.message.from;
    const request = {
        chatId: message.message.chat.id,
        username: from.username,
        name: from.first_name || from.username,
        text: message.message.text,
        timestamp: message.message.date
    };
    logger.debug('webhook', request, message.message);
    handleTelegramLogin(request);
}

async function handleTelegramLogin(request) {
    const match = request.text.match(/\/login$/);
    if (!match) {
        await sendTelegram(request.chatId, 'html', [
            `Try <code>/login</code>`
        ]);
        return;
    }
    const username = request.username;
    const token = generateToken(8);
    const loginKey = [config.namespace, 'login', token].join(':');
    let [hmset] = await multiExecAsync(client, multi => {
        multi.hmset(loginKey, {username});
        multi.expire(loginKey, config.loginExpire);
    });
    if (hmset) {
        await sendTelegramReply(request, 'html', [
            `You can login via https://${[config.domain, 'login', username, token].join('/')}.`,
            `This login expires in ${config.loginExpire} seconds`
        ]);
    } else {
        await sendTelegramReply(request, 'html', [
            `Apologies, the login command failed.`,
        ]);
    }
}

async function sendTelegramReply(request, format, ...content) {
    if (request.chatId && request.name) {
        await sendTelegram(request.chatId, format,
            `Thanks, ${request.name}.`,
            ...content
        );
    } else {
        logger.error('sendTelegramReply', request);
    }
}

async function sendTelegram(chatId, format, ...content) {
    logger.debug('sendTelegram', chatId, format, content);
    try {
        const text = lodash.trim(lodash.flatten(content).join(' '));
        assert(chatId, 'chatId');
        let uri = `sendMessage?chat_id=${chatId}`;
        uri += '&disable_notification=true';
        if (format === 'markdown') {
            uri += `&parse_mode=Markdown`;
        } else if (format === 'html') {
            uri += `&parse_mode=HTML`;
        }
        uri += `&text=${encodeURIComponent(text)}`;
        const url = [state.botUrl, uri].join('/');
        logger.info('sendTelegram url', url, chatId, format, text);
        const res = await fetch(url, {timeout: config.sendTimeout});
        if (res.status !== 200) {
            logger.warn('sendTelegram', chatId, url);
        }
    } catch (err) {
        logger.error(err);
    }
}

async function end() {
    sub.quit();
}
