import * as net from "net";
import { Socket, TcpNetConnectOpts } from "net";
import * as http from "http";
import * as https from "https";
import ip from "ip";

// Definition missing interface
declare module "http" {
    interface Agent {
        createConnection(options: TcpNetConnectOpts, connectionListener?: (error?: Error) => void): Socket;
    }
}

export interface RequestFilteringAgentOptions {
    // allow to connect private IP address
    // Example, http://127.0.0.1/, http://localhost/
    //Default: false
    allowPrivateIP?: boolean;
    // Allow address list
    // This values are preferred than denyAddressList
    // Default: []
    allowIPAddressList?: string[];
    // Deny address list
    // Default: []
    denyIPAddressList?: string[]
}


/**
 * validate the address that is matched the validation options
 * @param address ip address
 * @param host optional
 * @param family optional
 * @param options
 */
const validateAddress = ({ address, host, family }: { address: string; host?: string; family?: string | number }, options: Required<RequestFilteringAgentOptions>) => {
    // prefer allowed list
    if (options.allowIPAddressList.length > 0 && options.allowIPAddressList.includes(address)) {
        return;
    }

    if (!options.allowPrivateIP && ip.isPrivate(address)) {
        return new Error(`DNS lookup ${address}(family:${family}, host:${host}) is not allowed. Because, It is private IP address.`);
    }

    if (options.denyIPAddressList.length > 0 && options.denyIPAddressList.includes(address)) {
        return new Error(`DNS lookup ${address}(family:${family}, host:${host}) is not allowed. Because It is defined in denyIPAddressList.`);
    }
    return;
};

// dns lookup -> check
const addDropFilterSocket = (options: Required<RequestFilteringAgentOptions>, socket: net.Socket) => {
    socket.addListener("lookup", (err, address, family, host) => {
        if (err) {
            return;
        }
        const error = validateAddress({ address, family, host }, options);
        if (error) {
            socket.destroy(error);
        }
    });
};

// public
// prevent twice apply
const appliedAgentSet = new Set<http.Agent | https.Agent>();
/**
 * Apply request filter to http(s).Agent instance
 */
export const applyRequestFilter = (agent: http.Agent | http.Agent, options?: RequestFilteringAgentOptions) => {
    if (appliedAgentSet.has(agent)) {
        return agent;
    }
    appliedAgentSet.add(agent);
    const requestFilterOptions: Required<RequestFilteringAgentOptions> = {
        allowPrivateIP: options && options.allowPrivateIP !== undefined ? options.allowPrivateIP : false,
        allowIPAddressList: options && options.allowIPAddressList ? options.allowIPAddressList : [],
        denyIPAddressList: options && options.denyIPAddressList ? options.denyIPAddressList : []
    };
    // override http.Agent#createConnection
    // https://nodejs.org/api/http.html#http_agent_createconnection_options_callback
    // https://nodejs.org/api/net.html#net_net_createconnection_options_connectlistener
    const createConnection = agent.createConnection;
    agent.createConnection = (options, connectionListener) => {
        const socket = createConnection.call(agent, options, () => {
            // https://nodejs.org/api/net.html#net_socket_connect_options_connectlistener
            const { host } = options;
            if (host) {
                // Direct ip address request without dns-lookup
                // Example: http://127.0.0.1
                // https://nodejs.org/api/net.html#net_socket_connect_options_connectlistener
                const error = validateAddress({ address: host }, requestFilterOptions);
                if (error) {
                    socket.destroy(error);
                }
            }
            if (typeof connectionListener === "function") {
                connectionListener();
            }
        });
        // Request with domain name
        // Example: http://127.0.0.1.xip.io/
        addDropFilterSocket(requestFilterOptions, socket);
        return socket;
    };
    return agent;
};

/**
 * A subclsss of http.Agent with request filtering
 */
export class RequestFilteringHttpAgent extends http.Agent {
    constructor(options?: http.AgentOptions & RequestFilteringAgentOptions) {
        super(options);
        applyRequestFilter(this, options);
    }
}

/**
 * A subclsss of https.Agent with request filtering
 */
export class RequestFilteringHttpsAgent extends https.Agent {
    constructor(options?: https.AgentOptions & RequestFilteringAgentOptions) {
        super(options);
        applyRequestFilter(this, options);
    }
}

export const globalHttpAgent = new RequestFilteringHttpAgent();
export const globalHttpsAgent = new RequestFilteringHttpsAgent();
/**
 * get right an agent for the url
 * @param url
 */
export const useAgent = (url: string) => {
    return url.startsWith("https") ? globalHttpsAgent : globalHttpAgent;
};