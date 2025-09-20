# SSH MCP Server

A Model Context Protocol (MCP) server that enables SSH remote command execution on remote machines with **persistent connections**. This server provides a secure way to connect to remote servers, execute commands, and retrieve output through the MCP protocol while maintaining long-lived SSH sessions for improved performance.

## Features

- **Persistent SSH connections** - Maintains long-lived SSH sessions for better performance
- **Automatic connection management** - Reuses connections, automatically reconnects if lost
- **Connection pooling** - Manages multiple SSH connections efficiently
- Execute commands on remote servers via SSH
- **Automatic SSH key discovery** - Works like standard `ssh` command, automatically finds keys in `~/.ssh/`
- Support for both SSH key and password authentication
- SSH agent forwarding support
- Configurable connection timeouts
- Detailed command execution results including stdout, stderr, and exit codes
- **Connection monitoring** - Track active connections, idle times, and connection status
- **Graceful cleanup** - Automatic cleanup of stale connections and graceful shutdown
- Error handling and reporting

## Installation

### From npm (Recommended)

```bash
npm install -g @alolite/ssh-mcp
```

### From source

1. Clone the repository:
```bash
git clone <repository-url>
cd ssh-mcp
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

## Usage

The server exposes two main tools: `ssh_execute` and `ssh_connections`

### ssh_execute

Execute a command on a remote server via SSH with persistent connections, just like using `ssh -A username@hostname`.

**Key Benefits of Persistent Connections:**
- First command to a server establishes the connection
- Subsequent commands reuse the existing connection (much faster)
- Connections are automatically maintained and monitored
- Automatic reconnection if connection is lost
- Connection cleanup after 30 minutes of inactivity

**Parameters:**
- `host` (string): SSH server hostname or IP address (e.g., 'dev234', '192.168.1.100')
- `username` (string): SSH username (e.g., 'username')
- `command` (string): Command to execute on the remote server
- `port` (number, optional): SSH server port (default: 22)
- `privateKeyPath` (string, optional): Path to SSH private key file (default: auto-discovered from ~/.ssh/)
- `passphrase` (string, optional): Passphrase for the private key (if required)
- `password` (string, optional): SSH password (only if not using SSH keys)
- `timeout` (number, optional): Connection timeout in milliseconds (default: 10000)
- `agentForward` (boolean, optional): Enable SSH agent forwarding (default: true)

### ssh_connections

Manage and monitor SSH connections in the connection pool.

**Parameters:**
- `action` (string): Action to perform:
  - `"list"`: List all active connections with status
  - `"close"`: Close a specific connection
  - `"close_all"`: Close all connections
- `connectionKey` (string, optional): Connection identifier (username@host:port) - required for "close" action

**Usage Examples:**
```javascript
// List all active connections
{
  "action": "list"
}

// Close a specific connection
{
  "action": "close",
  "connectionKey": "username@host:22"
}

// Close all connections
{
  "action": "close_all"
}
```

**Authentication Priority:**
1. If `password` is provided, use password authentication
2. Otherwise, use SSH key authentication (default behavior):
   - If `privateKeyPath` is specified, use that key
   - If not specified, automatically discover keys from `~/.ssh/` directory
   - Tries common key names: `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`

**Simple Usage Examples for ssh_execute:**
```javascript
// Basic command execution (like: ssh username@host 'ls -la')
// First run establishes connection, subsequent runs reuse it
{
  "host": "host",
  "username": "username", 
  "command": "ls -la"
}

// Second command on same server (reuses connection - much faster!)
{
  "host": "host",
  "username": "username", 
  "command": "pwd"
}

// Check disk space on production server
{
  "host": "prod-web-01.company.com",
  "username": "deploy",
  "command": "df -h"
}

// Run a command with specific SSH key
{
  "host": "staging-db",
  "username": "dbadmin",
  "privateKeyPath": "/home/user/.ssh/staging_rsa",
  "command": "systemctl status postgresql"
}
```

### Example Configuration for Claude Desktop

Add this to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "alolite-ssh-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ssh-mcp/build/index.js"]
    }
  }
}
```

## Security Considerations

- **Credentials**: This server requires SSH credentials to function. Be cautious about how credentials are provided and stored.
- **Command Execution**: The server can execute arbitrary commands on remote systems. Ensure proper access controls.
- **Network Security**: SSH connections are encrypted, but ensure you're connecting to trusted hosts.
- **Logging**: Sensitive information like passwords are not logged, but command output may contain sensitive data.

## Development

For development, you can run the server directly with TypeScript:

```bash
npm run dev
```

## Testing

You can test the server using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

## Error Handling

The server provides comprehensive error handling:
- Connection timeouts
- Authentication failures
- Command execution errors
- Network connectivity issues

All errors are reported back through the MCP protocol with appropriate error messages.

## Publishing and Releases

This package is automatically published to npm when new releases are created on GitHub. 

### For Maintainers

To publish a new version:

1. Update the version in `package.json`:
   ```bash
   npm version patch|minor|major
   ```

2. Push the changes and tags:
   ```bash
   git push origin main --tags
   ```

3. Create a release on GitHub:
   - Go to the repository's releases page
   - Click "Create a new release"
   - Select the tag you just pushed
   - Add release notes describing the changes
   - Publish the release

4. The GitHub Action will automatically:
   - Build the project
   - Run tests (if available)
   - Publish to npm with provenance

### Setup Requirements

The npm publishing workflow requires:
- An `NPM_TOKEN` secret in the GitHub repository settings
- The token should have publish permissions for the package

## License

MIT
