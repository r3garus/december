//@ts-nocheck

import { ChatInput } from "./ChatInput";
import { ChatMessage } from "./ChatMessage";

export const ChatSidebar = ({
  messages,
  inputValue,
  setInputValue,
  onSendMessage,
  messagesEndRef,
  textareaRef,
  onKeyDown,
  formatMessageContent,
}) => {
  return (
    <div className="motion-drawer-panel flex min-h-0 w-full flex-[0_0_48%] flex-col border-b border-gray-800 bg-gray-900 lg:h-auto lg:w-80 lg:flex-none lg:border-b-0 lg:border-r">
      <div className="flex-1 custom-scrollbar overflow-y-auto p-4">
        <div className="space-y-4">
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              formatMessageContent={formatMessageContent}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <ChatInput
        inputValue={inputValue}
        setInputValue={setInputValue}
        onSendMessage={onSendMessage}
        textareaRef={textareaRef}
        onKeyDown={onKeyDown}
      />
    </div>
  );
};
