import React, { useState, useRef, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously } from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  getDoc,
  deleteDoc,
  updateDoc,
  arrayUnion
} from 'firebase/firestore';


// --- Firebase Globals (as per prompt) ---
declare const __firebase_config: any;
declare const __app_id: string;
declare const __initial_auth_token: string;

// --- Firebase Initialization ---
const firebaseApp = initializeApp(__firebase_config);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// --- Helper Components ---

// Modal Component for entering the share code
const ShareCodeModal = ({ onSubmit, onCancel }) => {
  const [code, setCode] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (code.trim()) {
      onSubmit(code.trim());
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-background-dark rounded-xl p-6 w-full max-w-sm">
        <h2 className="text-xl font-bold text-text-light-primary dark:text-text-dark-primary mb-4">Enter Share Code</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full p-2 border border-border-light dark:border-border-dark rounded-lg mb-4 text-center font-mono text-2xl"
            placeholder="123456"
            maxLength={6}
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg text-text-light-secondary dark:text-text-dark-secondary">Cancel</button>
            <button type="submit" className="px-4 py-2 rounded-lg bg-primary text-white font-bold">Receive</button>
          </div>
        </form>
      </div>
    </div>
  );
};


// --- Main App Component ---

const App = () => {
  const [mode, setMode] = useState('idle'); // 'idle', 'sending', 'receiving', 'transfer'
  const [status, setStatus] = useState('Waiting for connection...');
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [shareCode, setShareCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const receivedChunks = useRef<Array<ArrayBuffer>>([]);
  const receivedFileSize = useRef(0);
  const fileMetadata = useRef<{ name: string; size: number } | null>(null);


  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- WebRTC Configuration ---
  const servers = {
    iceServers: [
      {
        urls: ['stun:stun.l.google.com:19302'],
      },
    ],
    iceCandidatePoolSize: 10,
  };

  // --- Firebase Auth Effect ---
  useEffect(() => {
    const authenticateUser = async () => {
      try {
        if (__initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
        setStatus('Ready.');
      } catch (error) {
        console.error("Authentication failed:", error);
        setStatus('Authentication failed. Please refresh.');
      }
    };

    auth.onAuthStateChanged(user => {
      if (user) {
        setUserId(user.uid);
      } else {
        authenticateUser();
      }
    });
  }, []);

  // --- Firestore Path Helper ---
  const getFileTransferDocRef = (code: string) => {
    return doc(db, 'artifacts', __app_id, 'public/data/file_transfer', code);
  };

  // --- State Cleanup ---
  const resetState = () => {
    peerConnection.current?.close();
    peerConnection.current = null;
    dataChannel.current?.close();
    dataChannel.current = null;
    receivedChunks.current = [];
    receivedFileSize.current = 0;
    fileMetadata.current = null;
    setFile(null);
    setShareCode('');
    setMode('idle');
    setStatus('Waiting for connection...');
  };

  const handleCancel = async () => {
    if (shareCode) {
      const callDocRef = getFileTransferDocRef(shareCode);
      await deleteDoc(callDocRef);
    }
    resetState();
  };

  const handleSendClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setMode('sending');
    setStatus('Generating share code...');

    peerConnection.current = new RTCPeerConnection(servers);

    // Create data channel
    dataChannel.current = peerConnection.current.createDataChannel('file-transfer');
    dataChannel.current.onopen = () => {
        setStatus('Connection open! Sending file...');
        sendFileInChunks(selectedFile);
    };
    dataChannel.current.onclose = () => setStatus('Connection closed.');

    // Generate a unique 6-digit share code
    const newShareCode = Math.random().toString().substring(2, 8);
    setShareCode(newShareCode);
    const callDocRef = getFileTransferDocRef(newShareCode);

    // Setup ICE candidate listener
    peerConnection.current.onicecandidate = async (e) => {
      if (e.candidate) {
        await updateDoc(callDocRef, {
            offerCandidates: arrayUnion(e.candidate.toJSON())
        });
      }
    };

    // Create offer
    const offerDescription = await peerConnection.current.createOffer();
    await peerConnection.current.setLocalDescription(offerDescription);

    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };

    await setDoc(callDocRef, { offer, offerCandidates: [] });
    setStatus('Share code generated. Waiting for receiver...');

    // Listen for the answer from the receiver
    onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!peerConnection.current?.currentRemoteDescription && data?.answer) {
        const answerDescription = new RTCSessionDescription(data.answer);
        peerConnection.current?.setRemoteDescription(answerDescription);
        setStatus('Receiver connected. Establishing connection...');
      }

      // Listen for receiver's ICE candidates
      if (data?.answerCandidates) {
        data.answerCandidates.forEach(candidate => {
            peerConnection.current?.addIceCandidate(new RTCIceCandidate(candidate));
        });
      }
    });
  };

  const handleReceiveClick = () => {
    setShowReceiveModal(true);
  };

  const handleReceiveSubmit = async (code: string) => {
    setShowReceiveModal(false);
    setShareCode(code);
    setMode('receiving');
    setStatus(`Connecting with code: ${code}...`);

    peerConnection.current = new RTCPeerConnection(servers);

    // Listen for the data channel from the sender
    peerConnection.current.ondatachannel = (event) => {
      dataChannel.current = event.channel;
      dataChannel.current.onopen = () => setStatus('Connection open! Ready to receive file.');
      dataChannel.current.onclose = () => setStatus('Connection closed.');
    // The file transfer logic will be added here
      dataChannel.current.onmessage = (event) => {
        handleReceiveMessage(event.data);
      };
    };

    const callDocRef = getFileTransferDocRef(code);

    // Setup ICE candidate listener
    peerConnection.current.onicecandidate = async (e) => {
        if (e.candidate) {
            await updateDoc(callDocRef, {
                answerCandidates: arrayUnion(e.candidate.toJSON())
            });
        }
    };

    // Listen for the offer and create an answer
    onSnapshot(callDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (data?.offer && !peerConnection.current?.currentRemoteDescription) {
            setStatus('Offer received. Creating answer...');
            const offerDescription = new RTCSessionDescription(data.offer);
            await peerConnection.current?.setRemoteDescription(offerDescription);

            const answerDescription = await peerConnection.current?.createAnswer();
            await peerConnection.current?.setLocalDescription(answerDescription);

            const answer = {
                type: answerDescription.type,
                sdp: answerDescription.sdp,
            };

            await updateDoc(callDocRef, { answer, answerCandidates: [] });
            setStatus('Answer sent. Establishing connection...');
        }

        // Add sender's ICE candidates
        if (data?.offerCandidates) {
            data.offerCandidates.forEach(candidate => {
                peerConnection.current?.addIceCandidate(new RTCIceCandidate(candidate));
            });
        }
    });
  };

  // --- File Transfer Logic ---
  const sendFileInChunks = (fileToSend: File) => {
    const CHUNK_SIZE = 64 * 1024; // 64KB

    // 1. Send metadata first
    const metadata = { name: fileToSend.name, size: fileToSend.size };
    dataChannel.current?.send(JSON.stringify(metadata));

    // 2. Send file in chunks
    let offset = 0;
    const reader = new FileReader();

    reader.onload = () => {
      if (reader.result) {
        dataChannel.current?.send(reader.result as ArrayBuffer);
        offset += (reader.result as ArrayBuffer).byteLength;

        if (offset < fileToSend.size) {
          readSlice(offset);
        } else {
          setStatus('File sent successfully! Cleaning up...');
          // In a real app, you'd wait for receiver confirmation.
          // For this example, we'll delete after a short delay.
          setTimeout(async () => {
            if (shareCode) {
              const callDocRef = getFileTransferDocRef(shareCode);
              await deleteDoc(callDocRef);
            }
            resetState();
          }, 3000);
        }
      }
    };

    const readSlice = (o: number) => {
      const slice = fileToSend.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
  };

  const handleReceiveMessage = (data: any) => {
    // First message is metadata
    if (typeof data === 'string') {
      try {
        const metadata = JSON.parse(data);
        fileMetadata.current = metadata;
        receivedChunks.current = [];
        receivedFileSize.current = 0;
        setStatus(`Receiving file: ${metadata.name}`);
        return;
      } catch (e) {
        // Not a metadata string, likely a file chunk if something went wrong
      }
    }

    // Subsequent messages are file chunks (ArrayBuffer)
    if (data instanceof ArrayBuffer) {
        receivedChunks.current.push(data);
        receivedFileSize.current += data.byteLength;

        const progress = Math.round((receivedFileSize.current / fileMetadata.current!.size) * 100);
        setStatus(`Downloading... ${progress}%`);

        if (receivedFileSize.current === fileMetadata.current!.size) {
            setStatus('File received! Reassembling...');
            const fileBlob = new Blob(receivedChunks.current);

            // Create a download link and click it
            const url = URL.createObjectURL(fileBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileMetadata.current!.name;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();

            setStatus('File downloaded! Cleaning up...');
            setTimeout(() => {
                resetState();
                // We don't delete the doc here, as the sender might not be done.
                // A more robust system would have a confirmation step.
            }, 3000);
        }
    }
  };


  // Main View
  const renderMainView = () => (
    <div className="grid grid-rows-2 gap-4 flex-1">
      {/* Send Section */}
      <div
        onClick={handleSendClick}
        className="group flex cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border border-border-light dark:border-border-dark bg-white dark:bg-background-dark p-6 text-center transition-transform active:scale-[0.98]"
      >
        <span className="material-symbols-outlined text-primary text-5xl transition-transform group-hover:scale-110">
          arrow_upward
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-text-light-primary dark:text-text-dark-primary text-xl font-bold leading-tight">Send File</h2>
          <p className="text-text-light-secondary dark:text-text-dark-secondary text-base font-normal leading-normal">Select a file to share</p>
        </div>
      </div>
      {/* Receive Section */}
      <div
        onClick={handleReceiveClick}
        className="group flex cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border border-border-light dark:border-border-dark bg-white dark:bg-background-dark p-6 text-center transition-transform active:scale-[0.98]"
      >
        <span className="material-symbols-outlined text-primary text-5xl transition-transform group-hover:scale-110">
          arrow_downward
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-text-light-primary dark:text-text-dark-primary text-xl font-bold leading-tight">Receive File</h2>
          <p className="text-text-light-secondary dark:text-text-dark-secondary text-base font-normal leading-normal">Enter a code to receive a file</p>
        </div>
      </div>
    </div>
  );

    const renderSendingView = () => (
    <div className="flex flex-col items-center justify-center flex-1 text-center p-4">
        <h2 className="text-2xl font-bold text-text-light-primary dark:text-text-dark-primary">Your Share Code is:</h2>
        <p className="text-6xl font-bold text-primary my-4 tracking-widest">{shareCode || '...'}</p>
        <div className="mt-4 text-text-light-secondary dark:text-text-dark-secondary">
            {file && <p>File: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</p>}
            <p className="mt-2">{status}</p>
        </div>
        <button onClick={handleCancel} className="mt-8 px-6 py-2 rounded-lg bg-red-500 text-white font-bold">Cancel</button>
    </div>
  );

  const renderReceivingView = () => (
      <div className="flex flex-col items-center justify-center flex-1 text-center p-4">
          <h2 className="text-2xl font-bold text-text-light-primary dark:text-text-dark-primary">Receiving File...</h2>
          <p className="text-lg text-text-light-secondary dark:text-text-dark-secondary mt-2">{status}</p>
          <button onClick={handleCancel} className="mt-8 px-6 py-2 rounded-lg bg-red-500 text-white font-bold">Cancel</button>
      </div>
  );


  const renderContent = () => {
      switch (mode) {
          case 'sending':
              return renderSendingView();
          case 'receiving':
              return renderReceivingView();
          case 'idle':
          default:
              return renderMainView();
      }
  };

  return (
    <div className="font-display bg-background-light dark:bg-background-dark text-text-light-primary dark:text-text-dark-primary min-h-screen">
      <div className="relative flex h-screen w-full flex-col">
        {/* Top App Bar */}
        <div className="flex items-center p-4 pb-2 justify-between shrink-0">
          <div className="flex size-12 shrink-0 items-center justify-start">
            <span className="material-symbols-outlined text-3xl">all_out</span>
          </div>
          <h2 className="text-lg font-bold leading-tight tracking-[-0.015em] flex-1 text-center">FileFlow</h2>
          <div className="flex w-12 items-center justify-end"></div>
        </div>

        {/* Main Content */}
        <main className="flex flex-1 flex-col p-4 pt-2">
            {renderContent()}
        </main>

        {/* Footer / Connection Status */}
        <footer className="p-4 pt-0">
          <div className="flex items-center gap-3 bg-transparent px-4 min-h-14 justify-center">
            <div className="flex items-center gap-2">
              <div className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </div>
              <p className="text-text-light-secondary dark:text-text-dark-secondary text-sm font-medium leading-normal flex-1 truncate">{status}</p>
            </div>
          </div>
        </footer>

        {/* Hidden file input */}
        <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />

        {/* Modals */}
        {showReceiveModal && <ShareCodeModal onSubmit={handleReceiveSubmit} onCancel={() => setShowReceiveModal(false)} />}

      </div>
       {/* Injecting styles and fonts directly for single-file simplicity */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined');

        :root {
          --primary: #007AFF;
          --background-light: #F9F9F9;
          --background-dark: #101922;
          --text-light-primary: #1D1D1F;
          --text-light-secondary: #86868B;
          --text-dark-primary: #F5F5F7;
          --text-dark-secondary: #8D8D92;
          --border-light: #EAEAEB;
          --border-dark: #2E3A46;
        }

        .font-display { font-family: 'Inter', sans-serif; }
        .bg-background-light { background-color: var(--background-light); }
        .text-text-light-primary { color: var(--text-light-primary); }
        .text-text-light-secondary { color: var(--text-light-secondary); }
        .border-border-light { border-color: var(--border-light); }
        .bg-primary { background-color: var(--primary); }
        .text-primary { color: var(--primary); }

        .dark .bg-background-dark { background-color: var(--background-dark); }
        .dark .text-text-dark-primary { color: var(--text-dark-primary); }
        .dark .text-text-dark-secondary { color: var(--text-dark-secondary); }
        .dark .border-border-dark { border-color: var(--border-dark); }
        .dark .bg-white { background-color: #1C242C; } /* Adjusting for dark mode cards */

        .material-symbols-outlined {
            font-variation-settings:
            'FILL' 0,
            'wght' 300,
            'GRAD' 0,
            'opsz' 24
        }
      `}</style>
    </div>
  );
};

export default App;