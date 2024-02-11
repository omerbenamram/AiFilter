const {LRUCache} = require('lru-cache');
import {OpenAI} from 'openai';

const lru_options = {
    max: 500,
}

const tweet_cache = new LRUCache(lru_options); // Initialize the cache
console.log("Cache size:", tweet_cache.size);

function getOptionValue(option_name) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(option_name, (result) => {
            if(chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError);
            }
            resolve(String(result[option_name]));
        });
    });
}

function createMessageFromTemplate(template, prompt_instruction, tweet) {
    let retval = template.replace('{tweet}', tweet);
    retval = retval.replace('{prompt_instructions}', prompt_instruction);
    return retval;
}

function calculateProbs(log_probs) {
    const yes_logprobs = [];
    const no_logprobs = [];

    for(const [token, lp] of Object.entries(log_probs.top_logprobs[0])) {
        if(token.toUpperCase() === "YES" || token.toUpperCase() === "Y") {
            yes_logprobs.push(lp);
        } else if(token.toUpperCase() === "NO" || token.toUpperCase() === "N") {
            no_logprobs.push(lp);
        }
    }

    const total_yes_prob = yes_logprobs.reduce((acc, logprob) => acc + Math.exp(logprob), 0);
    const total_no_prob = no_logprobs.reduce((acc, logprob) => acc + Math.exp(logprob), 0);

    const yes_prob = total_yes_prob / (total_yes_prob + total_no_prob);
    const no_prob = total_no_prob / (total_yes_prob + total_no_prob);

    return {log_probs, yes_prob, no_prob};
}

// Function to decide whether to hide a tweet
async function shouldHideTweet(llm_config, tweet_text) {
    if (tweet_cache.has(tweet_text)) {
        return tweet_cache.get(tweet_text);
    }

    const tweetPromise = (async () => {
        try {
            const prompt = createMessageFromTemplate(
                llm_config.prompt_template, llm_config.prompt_instructions, tweet_text);

            // Using the chat.completions.create method
            const chatCompletion = await llm_config.openai_client.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: llm_config.model,
            });

            // Assuming the structure of the response and extracting the decision
            // This part might need adjustment based on the actual response structure
            const completionText = chatCompletion.choices[0].message.content.trim();
            const result = completionText.toLowerCase().includes("no"); // Adjust this logic based on your completion handling

            if (result) {
                console.log('Hiding tweet:', tweet_text);
            }
            return result;
        } catch (error) {
            console.error('Error:', error);
            return false;
        }
    })();

    tweet_cache.set(tweet_text, tweetPromise);
    return tweetPromise;
}

// Function to process and hide tweets
async function processTweets(llm_config) {
    const tweetSelector = 'div[data-testid="tweetText"]';
    for(const tweet of document.querySelectorAll(tweetSelector)) {
        const tweet_text = tweet.textContent;
        if(await shouldHideTweet(llm_config, tweet_text)) {
            const article = tweet.closest('article');
            if(article) {
                article.style.display = 'none';
            }
        }
    }
}


// Call the function initially to hide existing tweets
processTweets().then(() => {
    console.log('Done hiding existing tweets');
});

async function initializeClient() {
    try {
        const api_url = await getOptionValue('apiUrl');
        const api_key = await getOptionValue('apiKey');
        console.log('Using API URL:', api_url);
        console.log(`Using API Key: ${api_key.slice(0, 4)}****${api_key.slice(-4)}`);
        const client = new OpenAI({
            baseURL: api_url, apiKey: api_key, dangerouslyAllowBrowser: true
        });

        const model = "gpt-3.5-turbo-0125";
        console.log('Using model:', model);

        const prompt_template = await getOptionValue('prompt_template');
        console.log('Using prompt template:', prompt_template);

        const prompt_instructions = await getOptionValue('prompt_instructions')
        console.log('Using prompt instructions:', prompt_instructions);

        const hide_threshold_str = await getOptionValue('hide_threshold');
        console.log('Got hide threshold str:', hide_threshold_str);

        const hide_threshold = parseFloat(hide_threshold_str);
        console.log('Using hide threshold:', hide_threshold);

        return {
            openai_client: client,
            model: model,
            prompt_template: prompt_template,
            prompt_instructions: prompt_instructions,
            hide_threshold: hide_threshold
        };
    } catch(error) {
        console.error('Error:', error);
        throw error;
    }
}

// Initialize the client and then set up the observer
initializeClient().then(llm_config => {
    // Call processTweets initially to hide existing tweets
    processTweets(llm_config).then(() => {
        console.log('Done hiding existing tweets');
    });
    // Use MutationObserver to watch for changes in the DOM
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if(mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                processTweets(llm_config)
                    .then(() => {
                        console.log('Done hiding new tweets');
                    });
            }
        });
    });

    // Start observing the DOM for changes
    const config = {childList: true, subtree: true};
    const targetNode = document.body; // Adjust this to the specific container
    observer.observe(targetNode, config);
}).catch(error => {
    console.error('Error initializing client:', error);
});
