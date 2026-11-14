import { useEffect, type PropsWithChildren } from 'react'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { PRIVY_APP_ID } from '@blackout/shared'
import { registerPrivyLogout } from '../api/auth'

function PrivyLogoutBridge({ children }: PropsWithChildren) {
  const { logout } = usePrivy()

  useEffect(() => registerPrivyLogout(logout), [logout])

  return children
}

export function PrivyRoot({ children }: PropsWithChildren) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['google', 'email', 'discord'],
        appearance: {
          theme: 'dark',
          accentColor: '#f4bd50',
          landingHeader: 'Enter the blackout',
          loginMessage: 'Keep your company and progress across devices.',
        },
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
          solana: { createOnLogin: 'off' },
        },
      }}
    >
      <PrivyLogoutBridge>{children}</PrivyLogoutBridge>
    </PrivyProvider>
  )
}
