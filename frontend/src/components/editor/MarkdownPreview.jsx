import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveAttachmentSrc } from './attachments';
import { remarkPlainLocalDocSelfLinks } from './localDocLinks';
import './PromptEditor.css';

const markdownPlugins = [remarkGfm, remarkPlainLocalDocSelfLinks];

export default function MarkdownPreview({ text = '', className = '' }) {
  return (
    <div className={`markdown-preview ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        components={{
          img: ({ src = '', alt = '' }) => {
            const resolved = resolveAttachmentSrc(src);
            if (!resolved) return null;
            return <img src={resolved} alt={alt} loading="lazy" />;
          },
        }}
      >
        {text || ''}
      </ReactMarkdown>
    </div>
  );
}
