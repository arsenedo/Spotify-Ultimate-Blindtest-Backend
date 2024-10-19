require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const Player = require("./classes/player.js");
const Game = require("./classes/game.js");
const Spotify = require("./classes/spotify.js");
const app = express();
const port = 3000;

// Initialize WebSocket server
const wss = new WebSocket.Server({ port: 8080 });

// Array with all games
const games = [];

const spotify = new Spotify(process.env.CLIENT_ID, process.env.SECRET);
spotify.getNewAuthToken();

// WebSocket event handling
wss.on("connection", (ws) => {
  let player;
  let game;

  const response = {
    code: "500",
    msg: "internal server error",
    data: {},
  };

  const updateResponse = (code, msg, data) => {
    response.code = code;
    response.msg = msg;
    response.data = data;
  };

  // Event listener for incoming messages
  ws.on("message", async (e) => {
    const data = JSON.parse(e);
    const payload = data.payload;

    switch (data.action) {
      // Registers a new player
      case "registerPlayer":
        game = games.find((game) => game.code === payload.code);

        if (!game) {
          response.code = 404;
          response.msg = "game not found";
          break;
        }

        player = new Player(game.players.length, payload.name, ws);

        game.addPlayer(player);

        // Broadcast the new player to everyone in the game
        for (const playerInGame of game.players) {
          const playerNames = game.getPlayerNames();
          // Response
          updateResponse(200, "A new player was created", {
            action: "updatePlayers",
            players: playerNames,
            code: payload.code,
          });

          playerInGame.ws.send(JSON.stringify(response));
        }
        break;
      // Register a new host
      case "registerHost":
        player = new Player(0, payload.name, ws);
        const code = generateCode();
        game = new Game(player, code, spotify);
        games.push(game);

        // Response
        updateResponse(200, "Created a game successfully!", {
          action: data.action,
          code,
        });

        ws.send(JSON.stringify(response));
        break;
      // Starts the game when host presses the start button
      case "startGame":
        if (!game) {
          updateResponse(404, "Game not found", {});
          ws.send(JSON.stringify(response));
          return;
        }

        if (game.players.length < 2) {
          updateResponse(403, "Not enough players to start the game", {});
          ws.send(JSON.stringify(response));
          return;
        }

        game.startGame();

        updateResponse(200, "Game has started!", {
          action: data.action,
          isStarted: true,
        });
        for (const player of game.players) {
          player.ws.send(JSON.stringify(response));
        }
        break;
      // Notifies the game that a player is ready
      case "playerReady":
        if (!game) {
          updateResponse(404, "Game not found", {
            action: "error",
          });
          ws.send(JSON.stringify(response));
          return;
        }

        if (game.setReady(player.name)) {
          updateResponse(200, "Player ready!", {
            action: data.action,
            name: payload.name,
          });
          ws.send(JSON.stringify(response));

          // Check if all players ready
          if (game.arePlayersReady()) {
            updateResponse(200, "All players are ready!", {
              action: "allReady",
            });
            for (const player of game.players) {
              player.ws.send(JSON.stringify(response));
            }
          }
          return;
        }

        updateResponse(404, "Couldn't update the players ready state!", {
          action: "error",
          name: player.name,
        });
        ws.send(JSON.stringify(response));
        break;

      case "appendAlbums":
        const existingAlbums = game.pushAlbums(payload.albums);
        existingAlbums.length === 0
          ? updateResponse(200, "All albums added!", { action: data.action })
          : updateResponse(
            207,
            `${existingAlbums.length} albums were not added`,
            { action: data.action, existingAlbums }
          );
        ws.send(JSON.stringify(response));
        break;

      case "songPicked":
        game = findGame(payload.code);
        const playerName = payload.name;
        const song = payload.song;

        const score = game.checkPlayerFinding(playerName, song);
        if (score === -1) {
          updateResponse(404, "Player not found", { action: "error", name: playerName });
          ws.send(JSON.stringify(response));
          return;
        }

        updateResponse(200, "Player score updated", { action: data.action, score });
        ws.send(JSON.stringify(response));
        break;
      // Async handlers
      case "playerLoaded":
        game = findGame(payload.code);

        if (!game) {
          updateResponse(404, "Game not found", {
            action: "error",
            code: payload.code,
          });
          ws.send(JSON.stringify(response));
          return;
        }

        if (game.setLoaded(payload.name)) {
          updateResponse(200, "Player loaded successfuly!", { action: data.action });
          ws.send(JSON.stringify(response));

          // Check if all players loaded
          if (game.arePlayersLoaded()) {
            game.allLoaded = true;

            const song = await game.getRandomSongFromRandomAlbum();
            // Broadcast the song to everyone in the game
            for (const player of game.players) {
              // Response
              updateResponse(200, "Song found!", {
                action: "songReceive",
                song,
              });

              player.ws.send(JSON.stringify(response));
            }

            setTimeout(() => {
              if (game.currRound < game.rounds) {
                game.nextRound();
                updateResponse(200, "Round over!", { action: "roundOver" });
                for (const player of game.players) {
                  player.ws.send(JSON.stringify(response));
                }
                return
              }
              const finalStats = game.gameOver();
              updateResponse(200, "Game over!", { action: "gameOver", finalStats });
              for (const player of game.players) {
                player.ws.send(JSON.stringify(response));
              }
            }, 25000);
          }

          return
        }

        updateResponse(404, "Couldn't update the players loaded state!", {
          action: "error",
          name: payload.name,
        });
        ws.send(JSON.stringify(response));
        break;
    }
  });

  // Utils
  const generateCode = () => {
    const numbers = 5;
    let code = "";
    for (let i = 0; i < numbers; i++) {
      if (i === 0) {
        code += Math.floor(Math.random() * 9) + 1;
        continue;
      }
      code += Math.floor(Math.random() * 10);
    }
    return code;
  };

  const findGame = (code) => {
    return games.find((game) => game.code === code);
  }
  // End utils

  // Event listener for client disconnection
  ws.on("close", () => {
    if(!player) {
      return;
    }

    const newPlayerList = game.removePlayer(player);
    if(newPlayerList.length !== 0) {
      for(const playerInGame of game.players) {
        updateResponse(200, "A player was removed!", {
          action : "updatePlayers", 
          players : game.getPlayerNames()
        });

        playerInGame.ws.send(JSON.stringify(response));
      }
    }
  });
});

app.listen(port, () => {
  console.log(`Backend server listening on port ${port}`);
});

app.get("/", (req, resp) => {
  req.send("Server updated!");
  spotify.getNewAuthToken();
});
