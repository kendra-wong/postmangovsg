import { Sequelize } from 'sequelize-typescript'
import { QueryTypes, Transaction } from 'sequelize'
import map from 'lodash/map'
import crypto from 'crypto'
import validator from 'validator'

import { loggerWithLabel } from '@core/logger'
import config from '@core/config'
import MailClient from '@shared/clients/mail-client.class'
import { TemplateClient, XSS_EMAIL_OPTION } from '@shared/templating'
import { ThemeClient } from '@shared/theme'
import { EmailResultRow, Message } from './interface'
import { getContactPrefLinksForEmail } from './util/contact-preference'

const templateClient = new TemplateClient({ xssOptions: XSS_EMAIL_OPTION })
const logger = loggerWithLabel(module)

class Email {
  private workerId: string
  private connection: Sequelize
  private mailService: MailClient
  constructor(workerId: string, connection: Sequelize) {
    this.workerId = workerId
    this.connection = connection
    this.mailService = new MailClient(
      config.get('mailOptions'),
      config.get('mailOptions.callbackHashSecret'),
      config.get('emailFallback.activate') ? config.get('mailFrom') : undefined,
      config.get('mailConfigurationSet')
    )
  }

  enqueueMessages(jobId: number, campaignId: number): Promise<void> {
    return this.connection
      .transaction(async (transaction: Transaction) => {
        await this.connection.query('SELECT enqueue_messages_email(:job_id);', {
          replacements: { job_id: jobId },
          type: QueryTypes.SELECT,
          transaction,
        })
        // This is to ensure that stats count tally with total count during sending
        // as enqueue step may set messages as invalid
        await this.connection.query(
          'SELECT update_stats_email_with_read(:campaign_id);',
          {
            replacements: { campaign_id: campaignId },
            type: QueryTypes.SELECT,
            transaction,
          }
        )
      })
      .then(() => {
        logger.info({
          message: 'Enqueued email messages',
          workerId: this.workerId,
          jobId,
          action: 'enqueueMessages',
        })
      })
  }

  async getMessages(jobId: number, rate: number): Promise<Message[]> {
    const showMastheadDomain = config.get('showMastheadDomain')

    const result = await this.connection.query<EmailResultRow>(
      'SELECT get_messages_to_send_email_with_agency(:job_id, :rate) AS message;',
      {
        replacements: { job_id: jobId, rate },
        type: QueryTypes.SELECT,
      }
    )
    const showContactPref = config.get('phonebookContactPref.enabled')
    if (showContactPref && result.length > 0) {
      try {
        const campaignId = result[0].message.campaignId as number
        const emailResult = await this.connection.query<{ email: string }>(
          'select u.email as email from users u where u.id = (select c.user_id from campaigns c where c.id = :campaignId);',
          {
            replacements: { campaignId },
            type: QueryTypes.SELECT,
          }
        )
        if (!emailResult || emailResult.length === 0) {
          throw new Error(
            'Unable to fetch user email from campaign for phonebook contact preference api'
          )
        }
        const userEmail = emailResult[0].email
        return await getContactPrefLinksForEmail(result, campaignId, userEmail)
      } catch (error) {
        logger.error({
          message: 'Unable to fetch contact preferences',
          error,
          workerId: this.workerId,
        })
        // If phonebook is down, we still want to continue sending the messages
      }
    }
    return map(result, (row) => {
      const { senderEmail } = row.message
      const showMasthead = senderEmail.endsWith(showMastheadDomain)
      return {
        ...row.message,
        showMasthead,
      }
    })
  }

  calculateHash(campaignId: number, recipient: string): string {
    const version = config.get('unsubscribeHmac.version')
    return crypto
      .createHmac(
        config.get(`unsubscribeHmac.${version}.algo`),
        config.get(`unsubscribeHmac.${version}.key`)
      )
      .update(`${campaignId}.${recipient}`)
      .digest('hex')
  }

  generateUnsubLink(campaignId: number, recipient: string): URL {
    const version = config.get('unsubscribeHmac.version')
    const hmac = this.calculateHash(campaignId, recipient)
    const link = new URL(
      `/unsubscribe/${version}`,
      config.get('unsubscribeUrl')
    )
    link.searchParams.append('c', campaignId.toString())
    link.searchParams.append('r', recipient)
    link.searchParams.append('h', hmac)
    return link
  }

  async sendMessage({
    id,
    recipient,
    params,
    body,
    subject,
    replyTo,
    from,
    campaignId,
    agencyName,
    agencyLogoURI,
    showMasthead,
    contactPrefLink,
  }: Message): Promise<void> {
    try {
      if (!validator.isEmail(recipient)) {
        throw new Error('Recipient is incorrectly formatted')
      }

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const hydratedSubject = templateClient.template(subject!, params)
      const hydratedBody = templateClient.template(body, params)
      const unsubLink = this.generateUnsubLink(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        campaignId!,
        recipient
      ).toString()
      const themedHTMLEmail = await ThemeClient.generateThemedHTMLEmail({
        body: hydratedBody,
        unsubLink,
        agencyName,
        agencyLogoURI,
        showMasthead,
        contactPrefLink,
      })

      await this.mailService.sendMail({
        from: from || config.get('mailFrom'),
        recipients: [recipient],
        subject: hydratedSubject,
        body: themedHTMLEmail,
        messageId: String(id),
        unsubLink,
        bcc: params.bcc ? params.bcc.split(',') : undefined,
        ...(replyTo ? { replyTo } : {}),
      })

      await this.connection.query(
        `UPDATE email_ops SET status='SENDING', delivered_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=:id;`,
        { replacements: { id }, type: QueryTypes.UPDATE }
      )
    } catch (error) {
      await this.connection.query(
        `UPDATE email_ops SET status='ERROR', delivered_at=clock_timestamp(), error_code=:error, updated_at=clock_timestamp() WHERE id=:id;`,
        {
          replacements: {
            id,
            error: (error as Error).message.substring(0, 255),
          },
          type: QueryTypes.UPDATE,
        }
      )
    }

    logger.info({
      message: 'Sent email message',
      workerId: this.workerId,
      id,
      action: 'sendMessage',
    })
  }

  async setSendingService(_: string): Promise<void> {
    // Do nothing
    return
  }

  destroySendingService(): void {
    // Do nothing
    return
  }
}

export default Email
