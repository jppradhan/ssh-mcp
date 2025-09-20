#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, ConnectConfig } from 'ssh2';
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Input schema for SSH connection parameters
const SSHExecuteSchema = z.object({
  host: z.string().describe("SSH server hostname or IP address (e.g., 'dev234' or '192.168.1.100')"),
  port: z.number().default(22).describe("SSH server port (default: 22)"),
  username: z.string().describe("SSH username (e.g., 'username')"),
  password: z.string().optional().describe("SSH password (only if not using SSH keys)"),
  privateKeyPath: z.string().optional().describe("Path to SSH private key file (default: ~/.ssh/id_rsa, ~/.ssh/id_ed25519, etc.)"),
  passphrase: z.string().optional().describe("Passphrase for the private key (if required)"),
  command: z.string().describe("Command to execute on the remote server"),
  timeout: z.number().default(10000).describe("Connection timeout in milliseconds (default: 10000)"),
  agentForward: z.boolean().default(true).describe("Enable SSH agent forwarding (default: true)")
});

type SSHExecuteParams = z.infer<typeof SSHExecuteSchema>;

// Interface for persistent SSH connection
interface PersistentSSHConnection {
  client: Client;
  config: ConnectConfig;
  connectionKey: string;
  isConnected: boolean;
  lastUsed: number;
  connectPromise?: Promise<void>;
}

// Connection pool to manage persistent SSH connections
class SSHConnectionPool {
  private connections: Map<string, PersistentSSHConnection> = new Map();
  private readonly connectionTimeout = 30 * 60 * 1000; // 30 minutes
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up stale connections every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleConnections();
    }, 5 * 60 * 1000);
  }

  private generateConnectionKey(host: string, port: number, username: string): string {
    return `${username}@${host}:${port}`;
  }

  private cleanupStaleConnections(): void {
    const now = Date.now();
    for (const [key, conn] of this.connections) {
      if (now - conn.lastUsed > this.connectionTimeout) {
        console.error(`Cleaning up stale connection: ${key}`);
        conn.client.end();
        this.connections.delete(key);
      }
    }
  }

  private async createConnection(params: SSHExecuteParams): Promise<PersistentSSHConnection> {
    const connectionKey = this.generateConnectionKey(params.host, params.port, params.username);
    const client = new Client();

    // Build connection config
    const config: ConnectConfig = {
      host: params.host,
      port: params.port,
      username: params.username,
      readyTimeout: params.timeout,
      agent: params.agentForward ? process.env.SSH_AUTH_SOCK : undefined
    };

    // Determine authentication method
    if (params.password) {
      config.password = params.password;
    } else {
      let privateKeyContent: string;
      
      if (params.privateKeyPath) {
        privateKeyContent = loadPrivateKey(params.privateKeyPath);
      } else {
        const availableKeys = findSSHKeys();
        if (availableKeys.length === 0) {
          throw new Error("No SSH keys found in ~/.ssh/. Please specify a privateKeyPath or use password authentication.");
        }
        privateKeyContent = loadPrivateKey(availableKeys[0]);
      }
      
      config.privateKey = privateKeyContent;
      if (params.passphrase) {
        config.passphrase = params.passphrase;
      }
    }

    const connection: PersistentSSHConnection = {
      client,
      config,
      connectionKey,
      isConnected: false,
      lastUsed: Date.now()
    };

    // Set up connection event handlers
    client.on('error', (err: any) => {
      console.error(`SSH connection error for ${connectionKey}:`, err);
      connection.isConnected = false;
      this.connections.delete(connectionKey);
    });

    client.on('end', () => {
      console.error(`SSH connection ended for ${connectionKey}`);
      connection.isConnected = false;
      this.connections.delete(connectionKey);
    });

    client.on('close', () => {
      console.error(`SSH connection closed for ${connectionKey}`);
      connection.isConnected = false;
      this.connections.delete(connectionKey);
    });

    // Create connection promise
    connection.connectPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        client.end();
        reject(new Error(`SSH connection timeout after ${params.timeout}ms`));
      }, params.timeout);

      client.on('ready', () => {
        clearTimeout(timeoutId);
        connection.isConnected = true;
        connection.connectPromise = undefined;
        console.error(`SSH connection established: ${connectionKey}`);
        resolve();
      });

      client.on('error', (err: any) => {
        clearTimeout(timeoutId);
        connection.connectPromise = undefined;
        reject(err);
      });

      client.connect(config);
    });

    this.connections.set(connectionKey, connection);
    return connection;
  }

  async getConnection(params: SSHExecuteParams): Promise<PersistentSSHConnection> {
    const connectionKey = this.generateConnectionKey(params.host, params.port, params.username);
    let connection = this.connections.get(connectionKey);

    // If connection doesn't exist or is not connected, create/recreate it
    if (!connection || !connection.isConnected) {
      if (connection && !connection.isConnected) {
        console.error(`Reconnecting to ${connectionKey}`);
        connection.client.end();
        this.connections.delete(connectionKey);
      }
      
      connection = await this.createConnection(params);
      await connection.connectPromise;
    }

    // Update last used timestamp
    connection.lastUsed = Date.now();
    return connection;
  }

  disconnect(): void {
    clearInterval(this.cleanupInterval);
    for (const [key, conn] of this.connections) {
      conn.client.end();
    }
    this.connections.clear();
  }
}

// Global connection pool instance
const sshPool = new SSHConnectionPool();

/**
 * Find SSH private key files in the default SSH directory
 */
function findSSHKeys(): string[] {
  const sshDir = path.join(os.homedir(), '.ssh');
  const commonKeyNames = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];
  const foundKeys: string[] = [];

  for (const keyName of commonKeyNames) {
    const keyPath = path.join(sshDir, keyName);
    try {
      if (fs.existsSync(keyPath) && fs.statSync(keyPath).isFile()) {
        foundKeys.push(keyPath);
      }
    } catch (error) {
      // Ignore errors for individual key files
    }
  }

  return foundKeys;
}

/**
 * Load SSH private key content from file
 */
function loadPrivateKey(keyPath: string): string {
  try {
    return fs.readFileSync(keyPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read private key from ${keyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Create the MCP server
const server = new McpServer({
  name: "@alolite/ssh-mcp",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {
      listChanged: true
    }
  }
});

/**
 * Execute a command on a remote SSH server using persistent connections
 */
async function executeSSHCommand(params: SSHExecuteParams): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise(async (resolve, reject) => {
    try {
      // Get or create persistent connection
      const connection = await sshPool.getConnection(params);
      
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;

      // Execute command on the persistent connection
      connection.client.exec(params.command, (err: any, stream: any) => {
        if (err) {
          reject(err);
          return;
        }

        stream.on('close', (code: number) => {
          exitCode = code;
          resolve({ stdout, stderr, exitCode });
        });

        stream.on('data', (data: any) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: any) => {
          stderr += data.toString();
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Register the SSH execute tool
server.registerTool(
  "ssh_execute",
  {
    description: "Execute a command on a remote server via SSH and return the output",
    inputSchema: SSHExecuteSchema.shape
  },
  async (params: SSHExecuteParams): Promise<CallToolResult> => {
    try {
      const result = await executeSSHCommand(params);
      
      // Format the response
      const response = {
        command: params.command,
        host: `${params.username}@${params.host}:${params.port}`,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.exitCode === 0
      };

      return {
        content: [
          {
            type: "text",
            text: `SSH Command Execution Result:

Host: ${response.host}
Command: ${response.command}
Exit Code: ${response.exitCode}
Success: ${response.success}

=== STDOUT ===
${response.stdout || '(no output)'}

=== STDERR ===
${response.stderr || '(no errors)'}
`
          }
        ],
        isError: result.exitCode !== 0
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        content: [
          {
            type: "text",
            text: `SSH Command Failed: ${errorMessage}`
          }
        ],
        isError: true
      };
    }
  }
);

// Register connection management tool
server.registerTool(
  "ssh_connections",
  {
    description: "Manage SSH connections (list active connections, close connections, get connection status)",
    inputSchema: {
      action: z.enum(["list", "close", "close_all"]).describe("Action to perform: list active connections, close specific connection, or close all connections"),
      connectionKey: z.string().optional().describe("Connection key (username@host:port) for close action")
    }
  },
  async (params: { action: "list" | "close" | "close_all"; connectionKey?: string }): Promise<CallToolResult> => {
    try {
      switch (params.action) {
        case "list":
          const connections = (sshPool as any).connections as Map<string, PersistentSSHConnection>;
          const activeConnections = Array.from(connections.entries()).map(([key, conn]) => ({
            connectionKey: key,
            isConnected: conn.isConnected,
            lastUsed: new Date(conn.lastUsed).toISOString(),
            minutesIdle: Math.floor((Date.now() - conn.lastUsed) / 60000)
          }));

          return {
            content: [
              {
                type: "text",
                text: `Active SSH Connections (${activeConnections.length}):

${activeConnections.length === 0 ? 'No active connections' : 
  activeConnections.map(conn => 
    `• ${conn.connectionKey} - ${conn.isConnected ? 'Connected' : 'Disconnected'} - Idle: ${conn.minutesIdle}m - Last used: ${conn.lastUsed}`
  ).join('\n')}`
              }
            ]
          };

        case "close":
          if (!params.connectionKey) {
            return {
              content: [{ type: "text", text: "Connection key is required for close action" }],
              isError: true
            };
          }

          const connectionsMap = (sshPool as any).connections as Map<string, PersistentSSHConnection>;
          const connection = connectionsMap.get(params.connectionKey);
          if (!connection) {
            return {
              content: [{ type: "text", text: `Connection not found: ${params.connectionKey}` }],
              isError: true
            };
          }

          connection.client.end();
          connectionsMap.delete(params.connectionKey);

          return {
            content: [
              {
                type: "text",
                text: `Connection closed: ${params.connectionKey}`
              }
            ]
          };

        case "close_all":
          const allConnections = (sshPool as any).connections as Map<string, PersistentSSHConnection>;
          const closedCount = allConnections.size;
          for (const [key, conn] of allConnections) {
            conn.client.end();
          }
          allConnections.clear();

          return {
            content: [
              {
                type: "text",
                text: `Closed ${closedCount} SSH connections`
              }
            ]
          };

        default:
          return {
            content: [{ type: "text", text: "Invalid action" }],
            isError: true
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        content: [
          {
            type: "text",
            text: `Connection management failed: ${errorMessage}`
          }
        ],
        isError: true
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  
  // Graceful shutdown handling
  process.on('SIGINT', () => {
    console.error('Received SIGINT, closing SSH connections...');
    sshPool.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('Received SIGTERM, closing SSH connections...');
    sshPool.disconnect();
    process.exit(0);
  });

  await server.connect(transport);
  console.error("SSH MCP Server running on stdio with persistent connections");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
