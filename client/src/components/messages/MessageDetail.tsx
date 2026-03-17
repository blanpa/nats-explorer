import { NatsMessage } from '../../store';
import { formatBytes } from '../../lib/utils';

export default function MessageDetail({ message }: { message: NatsMessage }) {
  const time = new Date(message.timestamp);
  return (
    <div className="msg-detail">
      <div className="msg-detail-meta">
        <span>Subject: <code>{message.subject}</code></span>
        <span>Size: {formatBytes(message.size)}</span>
        <span>Time: {time.toLocaleString()}.{time.getMilliseconds().toString().padStart(3, '0')}</span>
        <span>Type: {message.payloadType}</span>
        {message.reply && <span>Reply-To: <code>{message.reply}</code></span>}
      </div>
    </div>
  );
}
