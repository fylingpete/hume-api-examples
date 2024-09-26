import {
  Hume,
  HumeClient,
  convertBlobToBase64,
  convertBase64ToBlob,
  ensureSingleValidAudioTrack,
  getAudioStream,
  getBrowserSupportedMimeType,
  MimeType,
} from 'hume';
import './styles.css';

// Add this function at the top of your file, outside of any other function
function handleError(error: any) {
  console.error('An error occurred:', error);
  // You can add more error handling logic here if needed
}

(async () => {
  const toggleBtn = document.querySelector<HTMLButtonElement>('#toggle-btn');
  // Remove the chat div reference
  // const chat = document.querySelector<HTMLDivElement>('#chat');

  let isConnected = false;

  toggleBtn?.addEventListener('click', toggleConnection);

  /**
   * the Hume Client, includes methods for connecting to EVI and managing the Web Socket connection
   */
  let client: HumeClient | null = null;

  /**
   * the WebSocket instance
   */
  let socket: Hume.empathicVoice.chat.ChatSocket | null = null;

  /**
   * flag which denotes the intended state of the WebSocket
   */
  let connected = false;

  /**
   * the recorder responsible for recording the audio stream to be prepared as the audio input
   */
  let recorder: MediaRecorder | null = null;

  /**
   * the stream of audio captured from the user's microphone
   */
  let audioStream: MediaStream | null = null;

  /**
   * the current audio element to be played
   */
  let currentAudio: HTMLAudioElement | null = null;

  /**
   * flag which denotes whether audio is currently playing or not
   */
  let isPlaying = false;

  /**
   * flag which denotes whether to utilize chat resumability (preserve context from one chat to the next)
   */
  let resumeChats = true;

  /**
   * The ChatGroup ID used to resume the chat if disconnected unexpectedly
   */
  let chatGroupId: string | undefined;

  /**
   * audio playback queue
   */
  const audioQueue: Blob[] = [];

  /**
   * mime type supported by the browser the application is running in
   */
  const mimeType: MimeType = (() => {
    const result = getBrowserSupportedMimeType();
    return result.success ? result.mimeType : MimeType.WEBM;
  })();

  /**
   * instantiates interface config and client, sets up Web Socket handlers, and establishes secure Web Socket connection
   */
  async function connect(): Promise<void> {
    try {
      // instantiate the HumeClient with credentials to make authenticated requests
      if (!client) {
        client = new HumeClient({
          apiKey: import.meta.env.VITE_HUME_API_KEY || '',
          secretKey: import.meta.env.VITE_HUME_SECRET_KEY || '',
        });
      }

      // instantiates WebSocket and establishes an authenticated connection
      socket = await client.empathicVoice.chat.connect({
        configId: import.meta.env.VITE_HUME_CONFIG_ID || null,
        resumedChatGroupId: chatGroupId,
      });

      socket.on('open', handleWebSocketOpenEvent);
      socket.on('message', handleWebSocketMessageEvent);
      socket.on('error', handleWebSocketErrorEvent);
      socket.on('close', handleWebSocketCloseEvent);

      isConnected = true;
      updateToggleButtonState();
    } catch (error) {
      handleError(error);
      console.error('Failed to connect:', error);
    }
  }

  /**
   * stops audio capture and playback, and closes the Web Socket connection
   */
  function disconnect(): void {
    // stop audio playback
    stopAudio();

    // stop audio capture
    recorder?.stop();
    recorder = null;
    audioStream = null;

    // set connected state to false to prevent automatic reconnect
    connected = false;

    // IF resumeChats flag is false, reset chatGroupId so a new conversation is started when reconnecting
    if (!resumeChats) {
      chatGroupId = undefined;
    }

    // close the Web Socket connection
    socket?.close();

    isConnected = false;
    updateToggleButtonState();
  }

  /**
   * captures and records audio stream, and sends audio stream through the socket
   *
   * API Reference:
   * - `audio_input`: https://dev.hume.ai/reference/empathic-voice-interface-evi/chat/chat#send.Audio%20Input.type
   */
  async function captureAudio(): Promise<void> {
    audioStream = await getAudioStream();
    // ensure there is only one audio track in the stream
    ensureSingleValidAudioTrack(audioStream);

    // instantiate the media recorder
    recorder = new MediaRecorder(audioStream, { mimeType });

    // callback for when recorded chunk is available to be processed
    recorder.ondataavailable = async ({ data }) => {
      // IF size of data is smaller than 1 byte then do nothing
      if (data.size < 1) return;

      // base64 encode audio data
      const encodedAudioData = await convertBlobToBase64(data);

      // define the audio_input message JSON
      const audioInput: Omit<Hume.empathicVoice.AudioInput, 'type'> = {
        data: encodedAudioData,
      };

      // send audio_input message
      socket?.sendAudioInput(audioInput);
    };

    // capture audio input at a rate of 100ms (recommended)
    const timeSlice = 100;
    recorder.start(timeSlice);
  }

  /**
   * play the audio within the playback queue, converting each Blob into playable HTMLAudioElements
   */
  function playAudio(): void {
    // IF there is nothing in the audioQueue OR audio is currently playing then do nothing
    if (!audioQueue.length || isPlaying) return;

    // update isPlaying state
    isPlaying = true;

    // pull next audio output from the queue
    const audioBlob = audioQueue.shift();

    // IF audioBlob is unexpectedly undefined then do nothing
    if (!audioBlob) return;

    // converts Blob to AudioElement for playback
    const audioUrl = URL.createObjectURL(audioBlob);
    currentAudio = new Audio(audioUrl);

    // play audio
    currentAudio.play();

    // callback for when audio finishes playing
    currentAudio.onended = () => {
      // update isPlaying state
      isPlaying = false;

      // attempt to pull next audio output from queue
      if (audioQueue.length) playAudio();
    };
  }

  /**
   * stops audio playback, clears audio playback queue, and updates audio playback state
   */
  function stopAudio(): void {
    // stop the audio playback
    currentAudio?.pause();
    currentAudio = null;

    // update audio playback state
    isPlaying = false;

    // clear the audioQueue
    audioQueue.length = 0;
  }

  /**
   * callback function to handle a WebSocket opened event
   */
  async function handleWebSocketOpenEvent(): Promise<void> {
    /* place logic here which you would like invoked when the socket opens */
    console.log('Web socket connection opened');

    // ensures socket will reconnect if disconnected unintentionally
    connected = true;

    await captureAudio();
  }

  /**
   * callback function to handle a WebSocket message event
   *
   * API Reference:
   * - `user_message`: https://dev.hume.ai/reference/empathic-voice-interface-evi/chat/chat#receive.User%20Message.type
   * - `assistant_message`: https://dev.hume.ai/reference/empathic-voice-interface-evi/chat/chat#receive.Assistant%20Message.type
   * - `audio_output`: https://dev.hume.ai/reference/empathic-voice-interface-evi/chat/chat#receive.Audio%20Output.type
   * - `user_interruption`: https://dev.hume.ai/reference/empathic-voice-interface-evi/chat/chat#receive.User%20Interruption.type
   */
  async function handleWebSocketMessageEvent(
    message: Hume.empathicVoice.SubscribeEvent
  ): Promise<void> {
    switch (message.type) {
      case 'chat_metadata':
        chatGroupId = message.chatGroupId;
        break;
      case 'audio_output':
        const audioOutput = message.data;
        const blob = convertBase64ToBlob(audioOutput, mimeType);
        audioQueue.push(blob);
        if (audioQueue.length >= 1) playAudio();
        break;
      case 'user_interruption':
        stopAudio();
        break;
    }
  }

  /**
   * callback function to handle a WebSocket error event
   */
  function handleWebSocketErrorEvent(error: Error): void {
    console.error('WebSocket error:', error);
    handleError();
  }

  /**
   * callback function to handle a WebSocket closed event
   */
  async function handleWebSocketCloseEvent(): Promise<void> {
    console.log('Web socket connection closed');
    if (connected) {
      try {
        await connect();
      } catch (error) {
        handleError(error);
      }
    } else {
      handleError(new Error('WebSocket disconnected'));
    }
  }

  /**
   * updates the toggle button state
   */
  function updateToggleButtonState(): void {
    if (toggleBtn) {
      toggleBtn.textContent = isConnected ? 'Stop Conversation' : 'Start Conversation';
      if (isConnected) {
        toggleBtn.classList.add('active');
      } else {
        toggleBtn.classList.remove('active');
      }
    }
  }

  async function toggleConnection(): Promise<void> {
    if (isConnected) {
      disconnect();
    } else {
      await connect();
    }
    // Remove this line as it's now called in connect() and disconnect()
    // updateToggleButtonState();
  }

  // Initial button state
  updateToggleButtonState();

  // ... (keep the rest of the code)
})();

/**
 * The code below does not pertain to the EVI implementation, and only serves to style the UI.
 */

interface Score {
  emotion: string;
  score: string;
}

interface ChatMessage {
  role: Hume.empathicVoice.Role;
  timestamp: string;
  content: string;
  scores: Score[];
}

// Remove or comment out the ChatCard declaration if it's not being used
// class ChatCard {
//   private message: ChatMessage;

//   constructor(message: ChatMessage) {
//     this.message = message;
//   }

//   private createScoreItem(score: Score): HTMLElement {
//     const scoreItem = document.createElement('div');
//     scoreItem.className = 'score-item';
//     scoreItem.innerHTML = `${score.emotion}: <strong>${score.score}</strong>`;
//     return scoreItem;
//   }

//   public render(): HTMLElement {
//     const card = document.createElement('div');
//     card.className = `chat-card ${this.message.role}`;

//     const role = document.createElement('div');
//     role.className = 'role';
//     role.textContent =
//       this.message.role.charAt(0).toUpperCase() + this.message.role.slice(1);

//     const timestamp = document.createElement('div');
//     timestamp.className = 'timestamp';
//     timestamp.innerHTML = `<strong>${this.message.timestamp}</strong>`;

//     const content = document.createElement('div');
//     content.className = 'content';
//     content.textContent = this.message.content;

//     const scores = document.createElement('div');
//     scores.className = 'scores';
//     this.message.scores.forEach((score) => {
//       scores.appendChild(this.createScoreItem(score));
//     });

//     card.appendChild(role);
//     card.appendChild(timestamp);
//     card.appendChild(content);
//     card.appendChild(scores);

//     return card;
//   }
// }
