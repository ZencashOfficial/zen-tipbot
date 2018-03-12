"use strict";

const config = require("config");
const config_bot = config.get("bot");
const bitcoin = require("bitcoin");
const zen = new bitcoin.Client(config.get("zen"));
const zencashjs = require('zencashjs');
const randomBytes = require('crypto-browserify').randomBytes;
const mongoose = require("mongoose");
const axios = require("axios");

mongoose.Promise = global.Promise;
const mongodb = config.get("mongodb");
mongoose.connect(mongodb.url, mongodb.options);
const db = mongoose.connection;
db.on("error", console.error.bind(console, "connection error: "));
db.once("open", function () {
    console.log("Mongodb: connected to '" + this.host + "/" + this.name + "'!");
});

const userSchema = mongoose.Schema({
    "id": String,
    "priv": String,
    "privWIF": String,
    "pubKey": String,
    "address": String,
    "spent": Number,
    "received": Number
});
const User = mongoose.model("User", userSchema);

exports.commands = [
    "tip"
];

exports.tip = {
    usage: "<subcommand>",

    description: "Here is the commands you can use:\n"
    + "**!tip help** : display this message.\n"
    + "**!tip deposit** : get an address to top up your balance.\n"
    + "**!tip balance** : get your balance.\n"
    + "**!tip withdraw <amount> <address>** : withdraw <amount> ZENs from your"
    + " balance to your <address>.\n"
    + "**!tip <@user> <amount> [message]** : tip <@user> <amount> ZENs (maximum"
    + " 1 ZEN) and leave an optional [message].\n"
    + "**!tip each <amount> <n> [message]** : drop a packet in a channel, the"
    + " <amount> is divided *equally* between the <n> first people to open"
    + " the packet. Leave an optionnal [message] with the packet.\n"
    + "**!tip luck <amount> <n> [message]** : drop a packet in a channel, the"
    + " <amount> is divided *randomly* between the <n> first people to open"
    + " the packet. Leave an optionnal [message] with the packet.\n"
    + "**!tip open** : open the latest packet dropped into the channel.\n",

    process: async function (bot, msg) {
        getUser(msg.author.id, function (err, doc) {
            if (err) return console.error(err);

            const tipper = doc;
            const words = msg.content.trim().split(" ").filter(
                function (n) {
                    return n !== "";
                }
            );
            const subcommand = words.length >= 2 ? words[1] : "help";

            switch (subcommand) {
                case "help":
                    doHelp(msg);
                    break;

                case "balance":
                    doBalance(msg, tipper);
                    break;

                case "deposit":
                    doDeposit(msg, tipper);
                    break;

                case "withdraw":
                    doWithdraw(msg, tipper, words);
                    break;

                case "each":
                    createTipEach(msg, tipper, words);
                    break;

                case "luck":
                    createTipLuck(msg, tipper, words);
                    break;

                case "open":
                    doOpenTip(msg, tipper, words, bot);
                    break;

                default:
                    doTip(msg, tipper, words, bot);
            }
        });
    }
};

let tipAllChannels = [];
const allowedFiatCurrencySymbols = [
    "usd", "eur", "rub", "jpy", "gbp", "aud", "brl", "cad", "chf", "clp", "cny",
    "czk", "dkk", "hkd", "idr", "ils", "inr", "krw", "mxn", "myr", "nok", "nzd",
    "php", "pkr", "pln", "sek", "sgd", "thb", "try", "twd", "zar"
];

/**
 * @param message
 */
function doHelp(message) {
    if (message.channel.type !== "dm") {
        return message.reply("send me this command in direct message!");
    }

    message.author.send(
        "Here are the commands you can use:\n"
        + "**!tip help** : display this message.\n\n"
        + "**!tip deposit** : get an address to top up your balance. "
        + "`Warning:` Mining directly into your `tip-bot-address` is "
        + "prohibited (You won't be able to use these ZENs)! And no support "
        + "for retrieving these ZENs will be provided!\n\n"
        + "**!tip balance** : get your balance.\n\n"
        + "**!tip withdraw <amount> <address>** : withdraw <amount> ZENs from "
        + "your balance to your `T` <address> (Only `T` addresses are "
        + "supported!).\n\n"
        + "**!tip luck <amount> <n> [message]** : drop a packet in a channel, "
        + "the <amount> is divided *randomly* (one tip is bigger, you can win "
        + "jackpot) between the <n> first people to open the packet. Leave an "
        + "optionnal [message] with the packet. Only one packet per channel is "
        + "allowed. Maximum is 20 people. Your packet will be active for next "
        + "20minutes, then can be overwritten. Maximum tip has to be ≤ 1 "
        + "ZEN.\n\n"
        + "**!tip each <amount> <n> [message]** : drop a packet in a channel, "
        + "the <amount> is divided *equally* between the <n> first people to "
        + "open the packet. Leave an optionnal [message] with the packet. Only "
        + "one packet per channel is allowed. Maximum is 20 people. Your "
        + "packet will be active for next 20 minutes, then can be overwritten. "
        + "Maximum tip has to be ≤ 1 ZEN.\n\n"
        + "**!tip <@user> <amount> [message]** : tip <@user> <amount> ZENs. "
        + "Maximum tip has to be ≤ 1 ZEN.\n\n"
        + "**!tip <@user> random [message]** : tip <@user> random ZENs where "
        + "random is <0.0, 0.1)\n\n"
        + "**!tip <@user> <amount><fiat_currency_ticker> [message]** : tip "
        + "<@user> ZENs in fiat equivalent. Example: **!tip @lukas 200czk**. "
        + "You can use <fiat_currency_ticker> with every command. Where "
        + "<fiat_currency_ticker> can be: USD, EUR, RUB, JPY, GBP, AUD, BRL, "
        + "CAD, CHF, CLP, CNY, CZK, DKK, HKD, IDR, ILS, INR, KRW, MXN, MYR, "
        + "NOK, NZD, PHP, PKR, PLN, SEK, SGD, THB, TRY, TWD, ZAR\n"
    );
}

/**
 * @param id
 * @param cb
 */
function getUser(id, cb) {
    //  default user
    const user = new User({
        id: id,
        priv: "",
        privWIF: "",
        pubKey: "",
        address: "",
        spent: 0,
        received: 0
    });

    // look for user in DB
    User.findOne({"id": id}, function (err, doc) {
        if (err) {
            return cb(err, null);
        }

        if (doc) {
            // Existing User
            return cb(null, doc);
        } else {
            // New User
            const seed = randomBytes((id % 65535) | 0);
            user.priv = zencashjs.address.mkPrivKey(seed.toString('hex'));
            user.privWIF = zencashjs.address.privKeyToWIF(user.priv)
            user.pubKey = zencashjs.address.privKeyToPubKey(user.priv)
            user.address = zencashjs.address.pubKeyToAddr(user.pubKey)

            user.save(function (err) {
                if (err) {
                    return cb(err, null);
                }
                return cb(null, user);
            });
        }
    });
}

/**
 * Calculate and return user's balance. DO NOT CONFUSE WITH doBalance!
 * @param tipper
 * @param cb
 */
function getBalance(tipper, cb) {
    // balance = total deposit amount + total received - total spent
    axios.get(
        "https://explorer.zensystem.io/insight-api-zen/addr/" + tipper.address
    )
    .then((res) => {
        const balance = res.data.totalReceived + tipper.received - tipper.spent;
        return cb(null, balance);
    })
    .catch((err) => {
        return cb(err, null);
    });
}

/**
 * Reply to !tip balance and display user's balance. DO NOT CONFUSE WITH getBalance!
 * @param message
 * @param tipper
 */
function doBalance(message, tipper) {
    if (message.channel.type !== "dm") {
        return message.reply("send me this command in direct message!");
    }

    getBalance(tipper, function (err, balance) {
        if (err) {
            return message.reply("error getting balance!");
        }

        message.reply("You have **" + balance + "** ZEN");
    });
}

/**
 * @param message
 * @param tipper
 */
function doDeposit(message, tipper) {
    if (message.channel.type !== "dm") {
        return message.reply("send me this command in direct message!");
    }

    message.reply("**WARNING: do not mine to this address, your ZENs will not"
    + " be credited to your balance !**\n\n" + "Your deposit address is:");
    message.reply(tipper.address);
}

/**
 * Calculate equivalent of ZEN in given currency.
 * @param amount - float - given in specific currency
 * @param fiatCurrencySymbol - string - fiat currency ticker
 * @param cb
 */
function getFiatToZenEquivalent(amount, fiatCurrencySymbol, cb) {
    const BASE_API_URL = "https://api.coinmarketcap.com/v1/ticker";
    let API_URL = BASE_API_URL + "/zencash/?convert=" + fiatCurrencySymbol;

    axios.get(API_URL).then(res => {
        const zenPrice = parseFloat(res.data[0]["price_" + fiatCurrencySymbol]);
        return cb(null, (amount / zenPrice).toFixed(8).toString());
    }).catch((err) => {
        return cb(err, null);
    });
}

/**
 * Validate syntax and check if user's balance is enough to manipulate the
 * requested amount and also stop manipulation if amount is 0.
 * @param tipper
 * @param message
 * @param amount
 * @param cb
 */
function getValidatedAmount(tipper, message, amount, cb) {
    getBalance(tipper, function (err, balance) {
        if(err){
            message.reply("Error getting your balance");
            return cb(err, null);
        }

        amount = amount.trim().toLowerCase();
        debugLog("getValidatedAmount amount: " + amount);

        let symbol = "";
        if(allowedFiatCurrencySymbols.indexOf(amount.slice(-3)) > -1
        || amount.toLowerCase().endsWith("zen")){
            // Has a correct currency symbol
            symbol = amount.slice(-3);

        } else if(amount.endsWith("zens")){
            symbol = "zen";

        } else if(amount === "random"){
            // random <0.0, 0.1) ZENs
            amount = Math.random() / 10;
        }

        // 8 decimals maximum
        amount = Math.trunc(parseFloat(amount) * 10e7) / 10e7;

        // Not A Number
        if(isNaN(amount)){
            message.reply("Error incorrect amount");
            return cb("NaN", null);
        }

        // Invalid amount
        if(amount > 9000){
            message.reply("what? Over 9000!");
            return cb("Over9K", null);
        }

        if(amount <= 0){
            message.reply("Amount should be >= 1e-8 Zen");
            return cb("0", null);
        }

        // get fiat to zen value
        if(symbol && symbol !== "zen"){
            getFiatToZenEquivalent(amount, symbol, function(err, value){
                if(err){
                    message.reply("Error getting fiat rate");
                    return cb(err, null);
                }
                if(value > balance){
                    message.reply("Your balance is too low");
                    return cb("balance", null);
                }
                return cb(null, value);
            });

        // zen value with no symbol
        } else {
            if(amount > balance){
                message.reply("Your balance is too low");
                return cb("balance", null);
            }
            return cb(null, amount);
        }
    });
}

/**
 * Validate amount if max is lower than maxTipZenAmount = 1
 * * @param amount
 */
function getValidatedMaxAmount(amount) {
    let maxTipZenAmount = 1;
    if (amount <= maxTipZenAmount) {
        return true;
    } else {
        return false;
    }
}

/**
 * @param message
 * @param tipper
 * @param words
 */
function doWithdraw(message, tipper, words) {
    if (message.channel.type !== "dm") {
        return message.reply("send me this command in direct message!");
    }

    //  wrong command syntax
    if (words.length < 4 || !words) {
        return doHelp(message);
    }

    getValidatedAmount(tipper, message, words[2], function(err, amount){
        if(err) return;

        const destinationAddress = words[3];

        let prefix = "zn";
        if (config_bot.testnet) {
            prefix = "zt";
        }

        // only T addresses are supported!
        if(destinationAddress.length !== 35
        || destinationAddress.toLowerCase().substring(0, 2) !== prefix){
            return message.reply("only `T` addresses are supported!");
        }

        zen.cmd("sendtoaddress", destinationAddress, amount, "", "", true,
            function (err, txId) {
                if (err) {
                    message.reply(err.message);
                } else {
                    // update tippers spent amount
                    User.update(
                        {id: tipper.id},
                        {"$inc": {spent: amount}},
                        function (err, raw) {
                            if (err) {
                                console.error(err);
                            } else {
                                console.log(raw);
                            }
                        }
                    );
                    return message.reply("you withdrew **" + amount.toString()
                    + " ZEN** (- fee) to **" + destinationAddress + "** (" +
                    txLink(txId) + ")!");
                }
            }
        );
    });
}

/**
 * @param set
 * @param channel_id
 */
function retreiveChannelTipObjIdx(set, channel_id) {
    for (let i = 0; i < set.length; i++) {
        if (set[i].channel_id === channel_id) {
            return i
        }
    }
    return null
}

/**
 * @param message
 * @param receiver
 * @param words
 * @param bot
 */
function doOpenTip(message, receiver, words, bot) {
    if (message.channel.type === "dm") {
        return message.reply("you can't send me this command in DM");
    }

    // wrong command syntax
    if (words.length < 2 || !words) {
        return doHelp(message);
    }

    let idx = retreiveChannelTipObjIdx(tipAllChannels, message.channel.id);
    if (idx === null) {
        return message.reply("sorry here isn't any tip for `open`");
    }
    debugLog("open idx" + idx);

    let tipper = tipAllChannels[idx].tipper;
    debugLog("open tipper.id" + tipper.id);

    getBalance(tipper, function (err, balance) {
        if (err) {
            return message.reply("error getting balance!");
        }

        let amount;
        if (tipAllChannels[idx].luck) {
            debugLog("open tipAllChannels[idx].n_used "
            + tipAllChannels[idx].n_used);
            debugLog("open tipAllChannels[idx].luck_tips "
            + tipAllChannels[idx].luck_tips);
            amount = parseFloat(
                tipAllChannels[idx].luck_tips[tipAllChannels[idx].n_used]
            ).toFixed(8);
        } else {
            debugLog("open tipAllChannels[idx].amount_total: "
            + tipAllChannels[idx].amount_total);
            debugLog("open tipAllChannels[idx].quotient "
            + tipAllChannels[idx].quotient);
            amount = parseFloat(tipAllChannels[idx].quotient).toFixed(8);
        }
        debugLog("open amount: " + amount);
        debugLog("open balance: " + balance);

        if ((amount <= 0) || (amount > balance)) {
            return message.reply("I don't know how to tip that many ZENs!");
        }

        // prevent user from opening your own tip
        if (tipper.id === message.author.id) {
            return message.reply("you can't `open` your own tip ...");
        }

        getUser(receiver.id, function (err, rec) {
            if (err) {
                return message.reply(err.message);
            }

            debugLog("open receiver.id " + receiver.id);

            for (let i = 0; i < tipAllChannels[idx].used_user.length; i++) {
                if (tipAllChannels[idx].used_user[i].id === message.author.id) {
                    return message.reply(
                        "you can't `open` this for the second time...");
                }
            }

            sendZen(tipper, receiver, amount);
            bot.users.get(tipper.id).send("<@" + message.author.id
            + "> received your tip (" + amount.toString() + " ZEN)!");
            message.author.send("<@" + tipper.id + "> sent you a **" +
            amount.toString() + " ZEN** tip !");

            debugLog("open message.author.id " + message.author.id);

            tipAllChannels[idx].n_used += 1;
            tipAllChannels[idx].used_user.push({
                id: message.author.id,
                amount: amount
            });

            debugLog("tipAllChannels[idx].n" + tipAllChannels[idx].n);
            debugLog("tipAllChannels[idx].n_used" + tipAllChannels[idx].n_used);

            // if empty, then remove from active list of open tips
            if (tipAllChannels[idx].n === tipAllChannels[idx].n_used) {
                tipAllChannels.splice(idx, 1);

                return message.reply("that was the last piece! Package from <@"
                + tipper.id + "> is now empty, thank you!");
            }
        });
    });
}

/**
 * Try to find if channel has been already used,
 * if so, then replace last open tip in that channel.
 * @param set of objects
 * @param obj - we are looking for this in 'set'
 */
function isChannelTipAlreadyExist(tip, message) {
    let now = new Date();
    // in minutes
    let allowedTimeBetweenChannelTips = 20;
    let diffMs;
    let diffMins;
    let type = tip.luck ? "LUCK" : "EACH";

    for (let i = 0; i < tipAllChannels.length; i++) {
        if (tipAllChannels[i].channel_id === tip.channel_id) {
            // milliseconds between now
            diffMs = (now - tipAllChannels[i].creation_date);
            // minutes
            diffMins = Math.round(((diffMs % 86400000) % 3600000) / 60000);

            debugLog("isChannelTipAlreadyExist diffMs: " + diffMs);
            debugLog("isChannelTipAlreadyExist diffMins: " + diffMins);

            if (diffMins > allowedTimeBetweenChannelTips) {
                // tip already exist, but it expire -> replace it
                tipAllChannels[i] = tip;
                message.reply("new tip `" + type + "` has been created ("
                + tip.amount_total.toString()
                + " ZEN)! Claim it with command `!tip open`");
                return 0
            } else {
                // tip already exist and is still valid
                message.reply("can't create new tip because,"
                + " previous tip is in progress!\n**"
                + tipAllChannels[i].n_used + "/"
                + tipAllChannels[i].n + " opened**\n**" + (20 - diffMins)
                + " minutes left**" );
                return 1
            }
        }
    }
    // tip doesnt exist in this channel -> create new
    tipAllChannels.push(tip);
    message.reply("new tip `" + type + "` has been created (" +
    tip.amount_total.toString() + " ZEN)! Claim it with command `!tip open`");
    return 2
}

/**
 * Shuffle array.
 * @param array
 */
function shuffle(array) {
    let counter = array.length;

    // While there are elements in the array
    while (counter > 0) {
        // Pick a random index
        let index = Math.floor(Math.random() * counter);

        // Decrease counter by 1
        counter--;

        // And swap the last element with it
        let temp = array[counter];
        array[counter] = array[index];
        array[index] = temp;
    }

    return array;
}

/**
 * @param message
 * @param tipper
 * @param words
 */
function createTipLuck(message, tipper, words) {
    if (message.channel.type === "dm") {
        return message.reply("you can't send me this command in DM");
    }

    // wrong command syntax
    if (words.length < 4 || !words) {
        return doHelp(message);
    }

    getValidatedAmount(tipper, message, words[2], function(err, amount){
        if(err) return;

        if(!getValidatedMaxAmount(amount)){
            return message.reply("Tip 1 zen maximum !");
        }

        let n = parseFloat(words[3]).toFixed(8);
        if (isNaN(n) || n <= 0) {
            return message.reply("I don't know how to tip that many people!");
        } else if (n > 20) {
            return message.reply("20 people is the maximum per packet!");
        }
        let quotient = (amount / n).toFixed(8);

        debugLog("createTipLuck amount" + amount);
        debugLog("createTipLuck n" + n);
        debugLog("createTipLuck quotient" + quotient);

        let luckTips = new Array(parseInt(n));
        if (n > 1) {
            for (let i = 0; i < (luckTips.length - 1); i++) {
                luckTips[i] = (Math.random() * parseFloat(quotient)).toFixed(8);
            }

            let sum = luckTips.reduce(function (total, num) {
                return parseFloat(total) + parseFloat(num)
            });
            debugLog("createTipLuck sum" + sum);

            luckTips[luckTips.length - 1] = (parseFloat(amount) -
                parseFloat(sum)).toFixed(8);
            debugLog("createTipLuck luckTips" + luckTips);

            // shuffle random tips (somewhere is BONUS) :-)
            luckTips = shuffle(luckTips);
            debugLog("createTipLuck luckTips (shuffled) " + luckTips);

        } else {
            luckTips[0] = parseFloat(amount).toFixed(8);
        }

        let tipOneChannel = {
            channel_id: message.channel.id,
            tipper: tipper,
            luck: true,
            amount_total: amount,
            quotient: quotient,
            n: parseInt(n),
            n_used: 0,
            luck_tips: luckTips,
            used_user: [],
            creation_date: new Date()
        };

        isChannelTipAlreadyExist(tipOneChannel, message);
    });
}

/**
 * @param message
 * @param tipper
 * @param words
 */
function createTipEach(message, tipper, words) {
    if (message.channel.type === "dm") {
        return message.reply("you can't send me this command in DM");
    }

    // wrong command syntax
    if (words.length < 4 || !words) {
        return doHelp(message);
    }

    getValidatedAmount(tipper, message, words[2], function(err, amount){
        if(err) return;

        if(!getValidatedMaxAmount(amount)){
            return message.reply("Tip 1 zen maximum !");
        }

        let n = parseFloat(words[3]).toFixed(8);
        if (isNaN(n) || n <= 0) {
            return message.reply("I don't know how to tip that many people!");
        } else if (n > 20) {
            return message.reply("20 people is the maximum per packet!");
        }
        let quotient = (amount / n).toFixed(8);

        debugLog("createTipEach n" + n);
        debugLog("createTipEach quotient" + quotient);
        debugLog("createTipEach amount" + amount);

        let tipOneChannel = {
            channel_id: message.channel.id,
            tipper: tipper,
            luck: false,
            amount_total: amount,
            quotient: quotient,
            n: parseInt(n),
            n_used: 0,
            used_user: [],
            creation_date: new Date()
        };

        isChannelTipAlreadyExist(tipOneChannel, message);
    });
}

/**
 * @param usertxt
 */
function resolveMention(usertxt) {
    let userid = usertxt;
    if (usertxt.startsWith("<@!")) {
        userid = usertxt.substr(3, usertxt.length - 4);
    } else {
        if (usertxt.startsWith("<@")) {
            userid = usertxt.substr(2, usertxt.length - 3);
        }
    }
    return userid;
}

/**
 * @param message
 * @param tipper
 * @param words
 * @param bot
 */
function doTip(message, tipper, words, bot) {
    if (message.channel.type === "dm") {
        return message.reply("you can't send me this command in DM");
    }

    // wrong command syntax
    if (words.length < 3 || !words) {
        return doHelp(message);
    }

    getValidatedAmount(tipper, message, words[2], function(err, amount){
        if(err) return;

        console.log(amount);

        if(!getValidatedMaxAmount(amount)){
            return message.reply("Tip 1 zen maximum !");
        }

        let targetId = resolveMention(words[1]);
        debugLog("doTip targetId" + targetId);

        bot.fetchUser(targetId, true).then(target => {
            debugLog("doTip target.id" + target.id);

            if (!target) {
                return message.reply("I cant't find a user in your tip ...");
            } else {
                if (tipper.id === target.id) {
                    return message.reply("you can't tip yourself ...");
                }

                getUser(target.id, function (err, receiver) {
                    if (err) {
                        return message.reply(err.message);
                    }

                    sendZen(tipper, receiver, amount);
                    message.author.send("<@" + receiver.id
                    + "> received your tip (" + amount + " ZEN)!");
                    target.send("<@" + tipper.id + "> sent you a **" + amount
                    + " ZEN** tip !");
                });
            }
        }).catch(err => {
            console.log("Failed fetch user: ", err);
        });
    });
}

/**
 * @param tipper
 * @param receiver
 * @param amount
 */
function sendZen(tipper, receiver, amount) {
    // update tipper's spent amount
    User.update(
        {id: tipper.id},
        {"$inc": {spent: amount}},
        function (err, raw) {
            if (err) {
                console.error(err);
            } else {
                console.log(raw);
            }
        }
    );

    // and receiver's received amount
    User.update(
        {id: receiver.id},
        {"$inc": {received: amount}},
        function (err, raw) {
            if (err) {
                console.error(err);
            } else {
                console.log(raw);
            }
        }
    );
}

/**
 * @param txId is transaction id
 */
function txLink(txId) {
    return "<https://explorer.zensystem.io/tx/" + txId + ">";
}

/**
 * @param log - log if bot is in debug mode
 */
function debugLog(log){
    if (config_bot.debug) {
        console.log(log);
    }
}
