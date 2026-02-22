const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Map to track rooms and peers
// Room structure: roomID -> Set of clients
const rooms = new Map();

wss.on('connection', (ws) => {
    let currentRoom = null;

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case 'join':
                const roomID = data.room || 'default-room';
                currentRoom = roomID;
                if (!rooms.has(roomID)) {
                    rooms.set(roomID, new Set());
                }

                // Max 2 people for this specific app use-case
                if (rooms.get(roomID).size >= 2) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
                    return;
                }

                rooms.get(roomID).add(ws);
                console.log(`User joined room: ${roomID}`);

                // Notify others in the room
                rooms.get(roomID).forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'peer-joined' }));
                    }
                });
                break;

            case 'offer':
            case 'answer':
            case 'candidate':
            case 'video-state': // For syncing movie playback
                // Broadcast to the other person in the room
                if (currentRoom && rooms.has(currentRoom)) {
                    rooms.get(currentRoom).forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    });
                }
                break;
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms.has(currentRoom)) {
            rooms.get(currentRoom).delete(ws);
            if (rooms.get(currentRoom).size === 0) {
                rooms.delete(currentRoom);
            } else {
                // Notify the other peer that this one left
                rooms.get(currentRoom).forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'peer-left' }));
                    }
                });
            }
        }
        console.log('Client disconnected');
    });
});

console.log('Signaling server running on ws://localhost:8080');
